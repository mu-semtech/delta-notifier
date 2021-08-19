import { app, uuid } from 'mu';
import request from 'request';
import services from '/config/rules.js';
import bodyParser from 'body-parser';
import dns from 'dns';

// Also parse application/json as json
app.use(bodyParser.json({
  type: function (req) {
    return /^application\/json/.test(req.get('content-type'));
  },
  limit: '500mb'
}));

// Log server config if requested
if (process.env["LOG_SERVER_CONFIGURATION"])
  console.log(JSON.stringify(services));

app.get('/', function (req, res) {
  res.status(200);
  res.send("Hello, delta notification is running");
});

app.post('/', function (req, res) {
  if (process.env["LOG_REQUESTS"]) {
    console.log("Logging request body");
    console.log(req.body);
  }

  console.log(req.body);
  console.log(req.get('mu-call-id-trail'));

  const changeSets = req.body.changeSets;

  // const originalMuCallIdTrail = JSON.parse(req.get('mu-call-id-trail') || "[]");
  const originalMuCallId = req.get('mu-call-id');
  // const muCallIdTrail = JSON.stringify([...originalMuCallIdTrail, originalMuCallId]);

  changeSets.forEach((change) => {
    change.effectiveInserts = change.effectiveInserts || [];
    change.effectiveDeletes = change.effectiveDeletes || [];
    change.inserts = change.inserts || [];
    change.deletes = change.deletes || [];
  });

  // inform watchers
  informWatchers(changeSets, res, originalMuCallId);

  // push relevant data to interested actors
  res.status(204).send();
});

// {
//   changeSets:
//   [{
//     origin: '172.28.0.1',
//     mu_call_id_trail: '[]',
//     insert: [Array],
//     delete: [Array],
//     index: 1629274666268,
//     authorization_groups:
//       '[{"variables":[],"name":"public"},{"variables":[],"name":"user-lookup"},{"variables":[],"name":"clean"}]'
//   }]
// }

function getMatchOnEffective(entry) {
  if (!(entry.options && "matchOnEffective" in entry.options)) return false; // DEFAULT
  return entry.options.matchOnEffective;
}

function getRequestPerMuCallIdTrail(entry) {
  if (!(entry.options && "requestPerMuCallIdTrail" in entry.options)) return true; // DEFAULT
  return entry.options.requestPerMuCallIdTrail;
}

async function informWatchers(changeSets, res, originalMuCallId) {
  services.map(async (entry) => {
    // for each entity
    if (process.env["DEBUG_DELTA_MATCH"])
      console.log(`Checking if we want to send to ${entry.callback.url}`);

    const matchSpec = entry.match;

    const originFilteredChangeSets = await filterMatchesForOrigin(changeSets, entry);
    if (process.env["DEBUG_TRIPLE_MATCHES_SPEC"] && entry.options.ignoreFromSelf)
      console.log(`There are ${originFilteredChangeSets.length} changes sets not from ${hostnameForEntry(entry)}`);

    let allInserts = [];
    let allDeletes = [];

    if (getMatchOnEffective(entry)) {
      originFilteredChangeSets.forEach((change) => {
        allInserts = [...allInserts, ...change.effectiveInserts];
        allDeletes = [...allDeletes, ...change.effectiveDeletes];
      });
    } else {
      originFilteredChangeSets.forEach((change) => {
        allInserts = [...allInserts, ...change.inserts];
        allDeletes = [...allDeletes, ...change.deletes];
      });
    }

    const changedTriples = [...allInserts, ...allDeletes];

    const someTripleMatchedSpec =
      changedTriples
        .some((triple) => tripleMatchesSpec(triple, matchSpec));

    if (process.env["DEBUG_TRIPLE_MATCHES_SPEC"])
      console.log(`Triple matches spec? ${someTripleMatchedSpec}`);

    if (someTripleMatchedSpec) {
      // inform matching entities
      if (process.env["DEBUG_DELTA_SEND"])
        console.log(`Going to send ${entry.callback.method} to ${entry.callback.url}`);

      if (entry.options && entry.options.gracePeriod) {
        setTimeout(
          () => sendRequest(entry, originFilteredChangeSets, originalMuCallId),
          entry.options.gracePeriod);
      } else {
        sendRequest(entry, originFilteredChangeSets, originalMuCallId);
      }
    }
  });
}

function tripleMatchesSpec(triple, matchSpec) {
  // form of triple is {s, p, o}, same as matchSpec
  if (process.env["DEBUG_TRIPLE_MATCHES_SPEC"])
    console.log(`Does ${JSON.stringify(triple)} match ${JSON.stringify(matchSpec)}?`);

  for (let key in matchSpec) {
    // key is one of s, p, o
    const subMatchSpec = matchSpec[key];
    const subMatchValue = triple[key];

    if (subMatchSpec && !subMatchValue)
      return false;

    for (let subKey in subMatchSpec)
      // we're now matching something like {type: "url", value: "http..."}
      if (subMatchSpec[subKey] !== subMatchValue[subKey])
        return false;
  }
  return true; // no false matches found, let's send a response
}


function formatChangesetBody(changeSets, options) {
  switch (options.resourceFormat) {
    case "v0.0.2":
      return formatV002(changeSets, options);
    case "v0.0.1":
      return formatV001(changeSets, options);
    case "v0.0.0-genesis":
      return formatV000Genesis(changeSets, options);
    default:
      throw `Unknown resource format ${options.resourceFormat}`;
  }
}


function formatV002(changeSets, options) {
  return JSON.stringify(
    changeSets.map((change) => {
      return {
        inserts: change.inserts,
        deletes: change.deletes,
        effectiveInserts: change.effectiveInserts,
        effectiveDeletes: change.effectiveDeletes,
        index: change.index
      };
    }));
}

function formatV001(changeSets, options) {
  return JSON.stringify(
    changeSets.map((change) => {
      return {
        inserts: change.inserts,
        deletes: change.deletes
      };
    }));
}

function formatV000Genesis(changeSets, options) {
  const newOptions = Object.assign({}, options, { resourceFormat: "v0.0.1" });
  const newFormat = JSON.parse(formatV001(changeSets, newOptions));
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
}

function createMuCallIdTrail(trail, originalMuCallId) {
  const originalMuCallIdTrail = JSON.parse(trail);
  const muCallIdTrail = JSON.stringify([...originalMuCallIdTrail, originalMuCallId]);
  return muCallIdTrail;
}

async function sendRequest(entry, changeSets, originalMuCallId) {
  const requestObjects = []; // will contain request information

  let changesPerMuCallIdTrail = {};

  if (getRequestPerMuCallIdTrail(entry)) {
    for (let change of changeSets) {
      const trail = change.muCallIdTrail || '[]';
      if (!changesPerMuCallIdTrail[trail]) changesPerMuCallIdTrail[trail] = [];
      changesPerMuCallIdTrail[trail].push(change);
    }
  } else {
    // Generic purposes, just one element to loop over
    changesPerMuCallIdTrail[changeSets[0].muCallIdTrail || '[]'] = changeSets;
  }

  // construct the requestObject
  const method = entry.callback.method;
  const url = entry.callback.url;

  for (let muCallIdTrail in changesPerMuCallIdTrail) {
    const full_trail = createMuCallIdTrail(muCallIdTrail, originalMuCallId);

    if (entry.options && entry.options.resourceFormat) {
      const current_changes = changesPerMuCallIdTrail[muCallIdTrail];

      const headers = { "Content-Type": "application/json", "MU-AUTH-ALLOWED-GROUPS": current_changes[0].allowedGroups, "mu-call-id-trail": full_trail, "mu-call-id": uuid() };
      // we should send contents
      const body = formatChangesetBody(current_changes, entry.options);

      // TODO: we now assume the mu-auth-allowed-groups will be the same
      // for each changeSet.  that's a simplification and we should not
      // depend on it.

      requestObjects.push({
        url, method,
        headers,
        body: body
      });
    } else {
      // we should only inform
      requestObjects.push({ url, method, headers });
    }
  }


  if (process.env["DEBUG_DELTA_SEND"])
    console.log(`Executing send ${method} to ${url}`);

  for (let requestObject of requestObjects) {
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
