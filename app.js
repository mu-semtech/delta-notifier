import { app, uuid } from 'mu';
import request from 'request';
import services from '/config/rules.js';
import bodyParser from 'body-parser';
import dns from 'dns';

// Also parse application/json as json
app.use( bodyParser.json( {
  type: function(req) {
    return /^application\/json/.test( req.get('content-type') );
  },
  limit: '500mb'
} ) );

// Log server config if requested
if( process.env["LOG_SERVER_CONFIGURATION"] )
  console.log(JSON.stringify( services ));

app.get( '/', function( req, res ) {
  res.status(200);
  res.send("Hello, delta notification is running");
} );

app.post( '/', function( req, res ) {
  if( process.env["LOG_REQUESTS"] ) {
    console.log("Logging request body");
    console.log(req.body);
  }

  const changeSets = req.body.changeSets;

  const originalMuCallIdTrail = JSON.parse( req.get('mu-call-id-trail') || "[]" );
  const originalMuCallId = req.get('mu-call-id');
  const muCallIdTrail = JSON.stringify( [...originalMuCallIdTrail, originalMuCallId] );

  changeSets.forEach( (change) => {
    change.insert = change.insert || [];
    change.delete = change.delete || [];
  } );

  // inform watchers
    informWatchers( changeSets, res, muCallIdTrail );

  // push relevant data to interested actors
  res.status(204).send();
} );

let changeSetsCache = []
let cacheTimeout = parseInt(process.env.CACHE_TIMEOUT || 2500);

async function informWatchers( changeSets, res, muCallIdTrail ){
  // HACK: the cache is a list of lists that each contain elements and will be emptied after the cacheTimeout is reached
  let changeSetsCopy = changeSets;
  changeSetsCache.push(changeSetsCopy);
  setTimeout(()=>{changeSetsCopy.length=0}, cacheTimeout)

  let usedChangeSets = [].concat(...changeSetsCache)
  console.log(`Size of changesetscache is ${changeSetsCache.length} length of used changeset ${usedChangeSets.length}`)

  services.map( async (entry) => {
    // for each entity
    if( process.env["DEBUG_DELTA_MATCH"] )
      console.log(`Checking if we want to send to ${entry.callback.url}`);

    const originFilteredChangeSets = await filterMatchesForOrigin(
      usedChangeSets,
      entry
    );
    if (
      process.env["DEBUG_TRIPLE_MATCHES_SPEC"] &&
      entry.options.ignoreFromSelf
    )
      console.log(
        `There are ${
          originFilteredChangeSets.length
        } changes sets not from ${hostnameForEntry(entry)}`
      );

    let allInserts = [];
    let allDeletes = [];

    originFilteredChangeSets.forEach((change) => {
      allInserts = [...allInserts, ...change.insert];
      allDeletes = [...allDeletes, ...change.delete];
    });


    const changedTriples = [...allInserts, ...allDeletes];
    let matchedSets = [];

    // TODO: add current changeset to cache with timeout
    // HACK: the cache is a list of lists that each contain elements and will be emptied after the cacheTimeout is reached
    //allInsertsCache.push(allInserts);
    //setTimeout(()=>{allInserts.length=0}, cacheTimeout)
    //allDeletesCache.push(allDeletes);
    //setTimeout(()=>{allDeletes.length=0}, cacheTimeout)
    //let cachedInserts = [].concat(...allInsertsCache);
    //let cachedDeletes = [].concat(...allDeletesCache);

    if (entry.subjectMatch) {
      let changedTriplesPerMatch = [];
      for (let spec of entry.subjectMatch) {
        let localMatches = allInserts.filter((triple) =>
          tripleMatchesSpec(triple, spec)
        );
        changedTriplesPerMatch.push(localMatches);
      }
      let subjectSets = changedTriplesPerMatch.map(
        (changes) => new Set(changes.map((change) => change.subject.value))
      );
      let subjects = subjectSets[0];
      for (let set of subjectSets) {
        subjects = new Set([...subjects].filter((e) => set.has(e)));
      }
      let changes = [];
      for (let changedTripleSet of changedTriplesPerMatch) {
        changedTripleSet.forEach((change) => {
          if (subjects.has(change.subject.value)) changes.push(change);
        });
      }
      if (changes) {
        let changeSet = originFilteredChangeSets[0] || {};
        changeSet.inserts = changes;
        matchedSets = [changeSet];
      }
    } else {
      if (changedTriples.some((triple) => tripleMatchesSpec(triple, entry.match)))
        matchedSets = originFilteredChangeSets;
    }

    if (process.env["DEBUG_TRIPLE_MATCHES_SPEC"])
      console.log(`How many triples match spec? ${matchedSets.length}`);

    if (matchedSets.length) {
      // inform matching entities
      if( process.env["DEBUG_DELTA_SEND"] )
        console.log(`Going to send ${entry.callback.method} to ${entry.callback.url}`);

      if( entry.options && entry.options.gracePeriod ) {
        setTimeout(
          () => sendRequest(entry, matchedSets, muCallIdTrail),
          entry.options.gracePeriod
        );
      } else {
        sendRequest(entry, matchedSets, muCallIdTrail);
      }
    }
  } );
}

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


function formatChangesetBody( changeSets, options ) {
  if( options.resourceFormat == "v0.0.1" ) {
    return JSON.stringify(
      changeSets.map( (change) => {
        return {
          inserts: change.insert,
          deletes: change.delete
        };
      } ) );
  }
  if( options.resourceFormat == "v0.0.0-genesis" ) {
    // [{delta: {inserts, deletes}]
    const newOptions = Object.assign({}, options, { resourceFormat: "v0.0.1" });
    const newFormat = JSON.parse( formatChangesetBody( changeSets, newOptions ) );
    return JSON.stringify({
      // graph: Not available
      delta: {
        inserts: newFormat
          .flatMap( ({inserts}) => inserts)
          .map( ({subject,predicate,object}) =>
                ( { s: subject.value, p: predicate.value, o: object.value } ) ),
        deletes: newFormat
          .flatMap( ({deletes}) => deletes)
          .map( ({subject,predicate,object}) =>
                ( { s: subject.value, p: predicate.value, o: object.value } ) )
      }
    });
  } else {
    throw `Unknown resource format ${options.resourceFormat}`;
  }
}

async function sendRequest( entry, changeSets, muCallIdTrail ) {
  let requestObject; // will contain request information

  // construct the requestObject
  const method = entry.callback.method;
  const url = entry.callback.url;
  const headers = { "Content-Type": "application/json", "MU-AUTH-ALLOWED-GROUPS": changeSets[0].allowedGroups, "mu-call-id-trail": muCallIdTrail, "mu-call-id": uuid() };

  if( entry.options && entry.options.resourceFormat ) {
    // we should send contents
    const body = formatChangesetBody( changeSets, entry.options );

    // TODO: we now assume the mu-auth-allowed-groups will be the same
    // for each changeSet.  that's a simplification and we should not
    // depend on it.

    requestObject = {
      url, method,
      headers,
      body: body
    };
  } else {
    // we should only inform
    requestObject = { url, method, headers };
  }

  if( process.env["DEBUG_DELTA_SEND"] )
    console.log(`Executing send ${method} to ${url}`);

  request( requestObject, function( error, response, body ) {
    if( error ) {
      console.log(`Could not send request ${method} ${url}`);
      console.log(error);
      console.log(`NOT RETRYING`); // TODO: retry a few times when delta's fail to send
    }

    if( response ) {
      // console.log( body );
    }
  });
}

async function filterMatchesForOrigin( changeSets, entry ) {
  if( ! entry.options || !entry.options.ignoreFromSelf ) {
    return changeSets;
  } else {
    const originIpAddress = await getServiceIp( entry );
    return changeSets.filter( (changeSet) => changeSet.origin != originIpAddress );
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
