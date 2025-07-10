import { app, errorHandler } from 'mu';
import services from './config/rules';
import normalizeQuad from './config/normalize-quad';
import bodyParser from 'body-parser';
import dns from 'dns';
import { foldChangeSets } from './folding';
import { sendRequest } from './send-request';
import { sendBundledRequest } from './bundle-requests';

// Log server config if requested
if( process.env["LOG_SERVER_CONFIGURATION"] )
  console.log(JSON.stringify( services ));

app.get( '/', function( req, res ) {
  res.status(200);
  res.send("Hello, delta notification is running");
} );

app.post( '/', bodyParser.json({limit: '500mb'}), function( req, res ) {
  if( process.env["LOG_REQUESTS"] ) {
    console.log("Logging request body");
    console.log(req.body);
  }

  const changeSets = req.body.changeSets;

  const originalMuCallIdTrail = JSON.parse( req.get('mu-call-id-trail') || "[]" );
  const originalMuCallId = req.get('mu-call-id');
  const muCallIdTrail = JSON.stringify( [...originalMuCallIdTrail, originalMuCallId] );
  const muSessionId = req.get('mu-session-id');

  changeSets.forEach( (change) => {
    ['insert', 'delete', 'effectiveInsert', 'effectiveDelete']
      .map( (key) => {
        change[key] = (change[key] || []).map(normalizeQuad);
      } );
  } );

  // inform watchers
  informWatchers( changeSets, res, muCallIdTrail, muSessionId );

  // push relevant data to interested actors
  res.status(204).send();
} );

async function informWatchers( changeSets, res, muCallIdTrail, muSessionId ){
  services.map( async (entry, index) => {
    entry.index = index;
    // for each entity
    if( process.env["DEBUG_DELTA_MATCH"] )
      console.log(`Checking if we want to send to ${entry.callback.url}`);

    const matchSpec = entry.match;

    const originFilteredChangeSets = await filterMatchesForOrigin( changeSets, entry );
    if( process.env["DEBUG_TRIPLE_MATCHES_SPEC"] && entry.options.ignoreFromSelf )
      console.log(`There are ${originFilteredChangeSets.length} changes sets not from ${hostnameForEntry( entry )}`);

    let allInserts = [];
    let allDeletes = [];

    originFilteredChangeSets.forEach( (change) => {
      allInserts = [...allInserts, ...change.insert];
      allDeletes = [...allDeletes, ...change.delete];
    } );

    const changedTriples = [...allInserts, ...allDeletes];

    const someTripleMatchedSpec =
        changedTriples
        .some( (triple) => tripleMatchesSpec( triple, matchSpec ) );

    if( process.env["DEBUG_TRIPLE_MATCHES_SPEC"] )
      console.log(`Triple matches spec? ${someTripleMatchedSpec}`);

    if( someTripleMatchedSpec ) {
      // inform matching entities
      if( process.env["DEBUG_DELTA_SEND"] )
        console.log(`Going to send ${entry.callback.method} to ${entry.callback.url}`);

      if( entry.options && entry.options.gracePeriod ) {
        sendBundledRequest(entry, originFilteredChangeSets, muCallIdTrail, muSessionId);
      } else {
        const foldedChangeSets = foldChangeSets( entry, originFilteredChangeSets );
        sendRequest( entry, foldedChangeSets, muCallIdTrail, muSessionId );
      }
    }
  } );
}

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    console.warn(`Payload too large for ${req.method} ${req.originalUrl}`);
    return res.status(413).json({
      errors: [ {title: 'Payload too large'} ]
    });
  }

  // Pass other errors to the default handler
  next(err);
});

app.use(errorHandler);

function tripleMatchesSpec( triple, matchSpec ) {
  // form of triple is {s, p, o}, same as matchSpec
  if( process.env["DEBUG_TRIPLE_MATCHES_SPEC"] )
    console.log(`Does ${JSON.stringify(triple)} match ${JSON.stringify(matchSpec)}?`);

  for( let key in matchSpec ){
    // key is one of s, p, o
    const subMatchSpec = matchSpec[key];
    const subMatchValue = triple[key];

    if( subMatchSpec && !subMatchValue )
      return false;

    for( let subKey in subMatchSpec )
      // we're now matching something like {type: "url", value: "http..."}
      if( subMatchSpec[subKey] !== subMatchValue[subKey] )
        return false;
  }
  return true; // no false matches found, let's send a response
}

async function filterMatchesForOrigin( changeSets, entry ) {
  if( ! entry.options || !entry.options.ignoreFromSelf ) {
    return changeSets;
  } else {
    try {
      const originIpAddress = await getServiceIp( entry );
      return changeSets.filter( (changeSet) => changeSet.origin != originIpAddress );
    } catch(e) {
      console.error(`Could not filter changeset because an error was returned while looking up ip for ${entry.callback.url}`);
      console.error(e);
      return changeSets;
    }
  }
}

function hostnameForEntry( entry ) {
  return (new URL(entry.callback.url)).hostname;
}

async function getServiceIp(entry) {
  const hostName = hostnameForEntry( entry );
  return new Promise( (resolve, reject) => {
    dns.lookup( hostName, { family: 4 }, ( err, address) => {
      if( err )
        reject( err );
      else
        resolve( address );
    } );
  } );
};
