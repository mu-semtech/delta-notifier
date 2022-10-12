import { app, uuid, query } from 'mu';
import request from 'request';
import rules from './config/rules';
import bodyParser from 'body-parser';
import dns from 'dns';
import ExpireArray from 'expire-array';
import ObjectSet from 'object-set-js';
import discoverBindings from './lib/pattern-matching';

const cacheTimeout = parseInt(process.env.CACHE_TIMEOUT || 2500);
const changeSetsCache = new ExpireArray(cacheTimeout);

const fetchMissingMatchesFromDatabase = process.env["FETCH_MISSING_MATCHES"] !== "false";

// Also parse application/json as json
app.use( bodyParser.json( {
  type: function(req) {
    return /^application\/json/.test( req.get('content-type') );
  },
  limit: '500mb'
} ) );

// Log server config if requested
if( process.env["LOG_SERVER_CONFIGURATION"] )
  console.log(JSON.stringify( rules ));

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

  // update changeset cache for match patterns
  changeSets.forEach(s=>{changeSetsCache.push(s);});

  // inform watchers
  informWatchers( changeSets, res, muCallIdTrail );

  // push relevant data to interested actors
  res.status(204).send();
} );

async function informWatchers( changeSets, _res, muCallIdTrail ){
  let usedChangeSets = changeSetsCache.all();

  rules.map( async (entry) => {
    // for each entity
    if( process.env["DEBUG_DELTA_MATCH"] )
      console.log(`Checking if we want to send to ${entry.callback.url}`);

    const originFilteredChangeSets = await filterMatchesForOrigin( changeSets, entry );

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


    const matchedSets = [];

    // Ensure match is an array
    entry.match = Array.isArray( entry.match ) ? entry.match : [entry.match];

    // Scan match patterns
    // TODO: this is static calculation from the configuration and should be done on startup
    const variableOccurrences = {};

    for (const matchSpec of entry.match) {
      for (const key in matchSpec) {
        if (matchSpec[key].type === "variable") {
          const name = matchSpec[key].value;
          variableOccurrences[name] = (variableOccurrences[name] || 0) + 1;
        }
      }
    }

    const variableNames = Object.keys(variableOccurrences);

    // TODO: do we want to advice against using variables?  It may clarify the configuration.
    for (const key in variableOccurrences)
      if (variableOccurrences[key] === 1)
        console.log(`Variable "${key}" might be misconfigured since it only occurs once`);

    // TODO: check for disconnected patterns (which may yield cross product)
    // person(?person) -> ?person a foaf:Person.
    // name(?person, ?result) -> ?person foaf:name ?result.

    // INSERT { :1 a foaf:Person. :2 a foaf:Person. }

    //entry.match = replaceEmptyMatchesWithVariables(entry.match);

    debugger;

    const solutions = await discoverBindings( allInserts, entry.match );

    console.log(solutions);
    debugger;

    // TODO: Send triples

    // TODO: Execute the same for deletes

    // TODO: Remove unused code from above

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

function singleTripleMatchesSpec( triple, matchSpec ) {
  // form of triple is {subject, predicate, object, graph}, same as matchSpec
  if( process.env["DEBUG_TRIPLE_MATCHES_SPEC"] )
    console.log(`Does ${JSON.stringify(triple)} match ${JSON.stringify(matchSpec)}?`);

  for( let key in matchSpec ) {
    // key is one of subject, predicate, object, graph
    const subMatchSpec = matchSpec[key];
    const subMatchValue = triple[key];

    // TODO: this should be replaced with a sanity check at configuration time for valid keys of match.
    if( subMatchSpec && !subMatchValue )
      return false;

    if (subMatchSpec.type === "variable")
      continue;

    for( let subKey in subMatchSpec )
      // we're now matching something like {type: "url", value: "http..."}
      if( subMatchSpec[subKey] !== subMatchValue[subKey] )
        return false;
  }
  return true; // no false matches found, let's send a response
}


function formatChangesetBody(changeSets, options) {
  if (options.resourceFormat == "v0.0.1") {
    return JSON.stringify(
      changeSets.map((change) => {
        return {
          inserts: change.insert,
          deletes: change.delete
        };
      }));
  }
  if (options.resourceFormat == "v0.0.0-genesis") {
    // [{delta: {inserts, deletes}]
    const newOptions = Object.assign({}, options, { resourceFormat: "v0.0.1" });
    const newFormat = JSON.parse(formatChangesetBody(changeSets, newOptions));
    return JSON.stringify({
      // graph: Not available
      delta: {
        inserts: newFormat
          .flatMap(({ inserts }) => inserts)
          .map(({ subject, predicate, object }) =>
            ({ s: subject.value, p: predicate.value, o: object.value })),
        deletes: newFormat
          .flatMap(({ deletes }) => deletes)
          .map(({ subject, predicate, object }) =>
            ({ s: subject.value, p: predicate.value, o: object.value }))
      }
    });
  } else {
    throw `Unknown resource format ${options.resourceFormat}`;
  }
}

async function sendRequest(entry, changeSets, muCallIdTrail) {
  let requestObject; // will contain request information

  // construct the requestObject
  const method = entry.callback.method;
  const url = entry.callback.url;
  const headers = { "Content-Type": "application/json", "MU-AUTH-ALLOWED-GROUPS": changeSets[0].allowedGroups, "mu-call-id-trail": muCallIdTrail, "mu-call-id": uuid() };

  if (entry.options && entry.options.resourceFormat) {
    // we should send contents
    const body = formatChangesetBody(changeSets, entry.options);

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

  if (process.env["DEBUG_DELTA_SEND"])
    console.log(`Executing send ${method} to ${url}`);

  request(requestObject, function (error, response, body) {
    if (error) {
      console.log(`Could not send request ${method} ${url}`);
      console.log(error);
      console.log(`NOT RETRYING`); // TODO: retry a few times when delta's fail to send
    }

    if (response) {
      // console.log( body );
    }
  });
}

async function filterMatchesForOrigin(changeSets, entry) {
  if (!entry.options || !entry.options.ignoreFromSelf) {
    return changeSets;
  } else {
    const originIpAddress = await getServiceIp(entry);
    return changeSets.filter((changeSet) => changeSet.origin != originIpAddress);
  }
}

function hostnameForEntry(entry) {
  return (new URL(entry.callback.url)).hostname;
}

async function getServiceIp(entry) {
  const hostName = hostnameForEntry(entry);
  return new Promise((resolve, reject) => {
    dns.lookup(hostName, { family: 4 }, (err, address) => {
      if (err)
        reject(err);
      else
        resolve(address);
    });
  });
};
