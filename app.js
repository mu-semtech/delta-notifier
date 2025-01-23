import { app } from 'mu';
import services from './config/rules';
import normalizeQuad from './config/normalize-quad';
import bodyParser from 'body-parser';
import { foldChangeSets } from './folding';
import { sendRequest } from './send-request';
import { sendBundledRequest } from './bundle-requests';
import {
  filterChangesetsOnPattern,
  tripleMatchesSpec,
  filterMatchesForOrigin,
  hostnameForEntry
} from './matching';

// Log server config if requested
if( process.env["LOG_SERVER_CONFIGURATION"] )
  console.log(JSON.stringify( services ));

const groupedServices = services.reduce((acc, service) => {
  // Create a unique key for the match pattern
  const matchKey = `${normalizeObject(service.match)}${service.options.sendMatchesOnly || false}`;
  if (!acc[matchKey]) {
    acc[matchKey] = [];
  }
  acc[matchKey].push(service);
  return acc;
}, {});


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
  // Iterate over each unique match pattern
  for (const matchKey in groupedServices) {
    const firstEntry = groupedServices[matchKey][0];
    // can use first entry since it's part of grouping
    const sendMatchesOnly = firstEntry.options.sendMatchesOnly;
    let maybePatternFilteredChangesets = changeSets;
    if (sendMatchesOnly) {
      maybePatternFilteredChangesets = filterChangesetsOnPattern(changeSets, firstEntry);
    }

    let allInserts = [];
    let allDeletes = [];
    maybePatternFilteredChangesets.forEach( (change) => {
      allInserts = [...allInserts, ...change.insert];
      allDeletes = [...allDeletes, ...change.delete];
    } );
    const changedTriples = [...allInserts, ...allDeletes];
    const someTripleMatchedSpec =
          changedTriples
          .some( (triple) => tripleMatchesSpec( triple, firstEntry.match ) );
    const matchingServices = groupedServices[matchKey];
    matchingServices.map( async (entry, index) => {
      if( process.env["DEBUG_TRIPLE_MATCHES_SPEC"] )
        console.log(`Triple matches spec? ${someTripleMatchedSpec}`);

      if( someTripleMatchedSpec ) {
        entry.index = index;
        // for each entity
        if( process.env["DEBUG_DELTA_MATCH"] )
          console.log(`Checking if we want to send to ${entry.callback.url}`);
        const matchSpec = entry.match;
        const originFilteredChangeSets = await filterMatchesForOrigin( maybePatternFilteredChangesets, entry );
        if( process.env["DEBUG_TRIPLE_MATCHES_SPEC"] && entry.options.ignoreFromSelf )
          console.log(`There are ${originFilteredChangeSets.length} changes sets not from ${hostnameForEntry( entry )}`);

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
}

/**
 * Normalizes an object by sorting its keys and converting it to a string.
 *
 * @param {Object} obj - The object to normalize.
 * @returns {string} A string representation of the normalized object.
 */
function normalizeObject(obj) {
  return JSON.stringify(Object.keys(obj)
                        .sort()
                        .reduce((acc, key) => {
                          acc[key] = obj[key];
                          return acc;
                        }, {}));
}
