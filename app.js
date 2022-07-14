import { app, uuid } from 'mu';
import services from '/config/rules.js';
import bodyParser from 'body-parser';
import dns from 'dns';
//Might need to enable the following on newer versions of NodeJS:
//import process from 'node:process';
import fetch from 'node-fetch';

// Also parse application/json as json
app.use(
  bodyParser.json({
    type: function (req) {
      return /^application\/json/.test(req.get('content-type'));
    },
    limit: '500mb',
  })
);

// Log server config if requested
if (process.env['LOG_SERVER_CONFIGURATION'])
  console.log(JSON.stringify(services));

app.get('/', function (req, res) {
  res.status(200);
  res.send('Hello, delta notification is running');
});

app.post('/', function (req, res) {
  if (process.env['LOG_REQUESTS'])
    console.log('Logging request body', req.body);

  const changeSets = req.body.changeSets;

  const originalMuCallIdTrail = JSON.parse(req.get('mu-call-id-trail') || '[]');
  const originalMuCallId = req.get('mu-call-id');
  const muCallIdTrail = JSON.stringify([
    ...originalMuCallIdTrail,
    originalMuCallId,
  ]);

  changeSets.forEach((change) => {
    change.insert = change.insert || [];
    change.delete = change.delete || [];
  });

  // inform watchers
  informWatchers(changeSets, res, muCallIdTrail);

  // push relevant data to interested actors
  res.status(204).send();
});

async function informWatchers(changeSets, res, muCallIdTrail) {
  services.map(async (entry) => {
    // for each entity
    //Logging
    if (process.env['DEBUG_DELTA_MATCH'])
      console.log(`Checking if we want to send to ${entry.callback.url}`);

    const matchSpec = entry.match;

    const originFilteredChangeSets = await filterMatchesForOrigin(
      changeSets,
      entry
    );

    //Logging
    if (
      process.env['DEBUG_TRIPLE_MATCHES_SPEC'] &&
      entry.options.ignoreFromSelf
    )
      console.log(
        `There are ${
          originFilteredChangeSets.length
        } changes sets not from ${hostnameForEntry(entry)}`
      );

    const matchSpecFilteredChangeSets = await filterChangeSetsForMatchSpec(
      originFilteredChangeSets,
      matchSpec
    );

    if (matchSpecFilteredChangeSets.length > 0) {
      //Logging
      if (process.env['DEBUG_DELTA_SEND'])
        console.log(
          `Going to send ${entry.callback.method} to ${entry.callback.url}`
        );

      // inform matching entities
      if (entry.options && entry.options.gracePeriod) {
        setTimeout(
          () => sendRequest(entry, matchSpecFilteredChangeSets, muCallIdTrail),
          entry.options.gracePeriod
        );
      } else {
        sendRequest(entry, matchSpecFilteredChangeSets, muCallIdTrail);
      }
    }
  });
}

function tripleMatchesSpec(triple, matchSpec) {
  // form of triple is {s, p, o}, same as matchSpec

  //Logging
  if (process.env['DEBUG_TRIPLE_MATCHES_SPEC'])
    console.log(
      `Does ${JSON.stringify(triple)} match ${JSON.stringify(matchSpec)}?`
    );

  for (let key in matchSpec) {
    // key is one of s, p, o
    const subMatchSpec = matchSpec[key];
    const subMatchValue = triple[key];

    if (subMatchSpec && !subMatchValue) {
      //Logging
      if (process.env['DEBUG_TRIPLE_MATCHES_SPEC'])
        console.log('Triple matches spec? NO');
      return false;
    }

    // we're now matching something like {type: "url", value: "http..."}
    for (let subKey in subMatchSpec)
      if (subMatchSpec[subKey] !== subMatchValue[subKey]) {
        //Logging
        if (process.env['DEBUG_TRIPLE_MATCHES_SPEC'])
          console.log('Triple matches spec? NO');
        return false;
      }
  }

  //Logging
  if (process.env['DEBUG_TRIPLE_MATCHES_SPEC'])
    console.log('Triple matches spec? YES');
  return true; // no false matches found, let's send a response
}

async function filterChangeSetsForMatchSpec(changeSets, matchSpec) {
  return changeSets
    .map((changeSet) => {
      changeSet.insert = changeSet.insert.filter((triple) =>
        tripleMatchesSpec(triple, matchSpec)
      );
      changeSet.delete = changeSet.delete.filter((triple) =>
        tripleMatchesSpec(triple, matchSpec)
      );
      return changeSet;
    })
    .reduce((accumulator, changeSet) => {
      if (
        changeSet &&
        (changeSet.insert.length > 0 || changeSet.delete.length > 0)
      )
        accumulator.push(changeSet);
      return accumulator;
    }, []);
}

function formatChangesetBody(changeSets, options) {
  if (options.resourceFormat == 'v0.0.1') {
    return JSON.stringify(
      changeSets.map((change) => {
        return {
          inserts: change.insert,
          deletes: change.delete,
        };
      })
    );
  }
  if (options.resourceFormat == 'v0.0.0-genesis') {
    // [{delta: {inserts, deletes}]
    const newOptions = Object.assign({}, options, { resourceFormat: 'v0.0.1' });
    const newFormat = JSON.parse(formatChangesetBody(changeSets, newOptions));
    return JSON.stringify({
      // graph: Not available
      delta: {
        inserts: newFormat
          .flatMap(({ inserts }) => inserts)
          .map(({ subject, predicate, object }) => ({
            s: subject.value,
            p: predicate.value,
            o: object.value,
          })),
        deletes: newFormat
          .flatMap(({ deletes }) => deletes)
          .map(({ subject, predicate, object }) => ({
            s: subject.value,
            p: predicate.value,
            o: object.value,
          })),
      },
    });
  } else {
    throw `Unknown resource format ${options.resourceFormat}`;
  }
}

async function sendRequest(entry, changeSets, muCallIdTrail) {
  // TODO: we now assume the mu-auth-allowed-groups will be the same
  // for each changeSet.  that's a simplification and we should not
  // depend on it.
  const requestObject = {
    method: entry.callback.method,
    headers: {
      'Content-Type': 'application/json',
      'MU-AUTH-ALLOWED-GROUPS': changeSets[0].allowedGroups,
      'mu-call-id-trail': muCallIdTrail,
      'mu-call-id': uuid(),
    },
  };
  if (entry.options && entry.options.resourceFormat)
    requestObject.body = formatChangesetBody(changeSets, entry.options);

  //Logging
  if (process.env['DEBUG_DELTA_SEND'])
    console.log(
      `Executing send ${requestObject.method} to ${entry.callback.url}`
    );

  try {
    await fetch(entry.callback.url, requestObject);
    //Logging
    if (process.env['DEBUG_DELTA_SEND'])
      console.log(
        `Send ${requestObject.method} to ${entry.callback.url} successful`
      );
  } catch (error) {
    console.error(
      `Could not send request ${requestObject.method} ${entry.callback.url}`
    );
    console.error(error);
    console.error('NOT RETRYING AFTER ERROR');
    // TODO: retry a few times when delta's fail to send
  }
}

async function filterMatchesForOrigin(changeSets, entry) {
  if (!entry.options || !entry.options.ignoreFromSelf) {
    return changeSets;
  } else {
    const originIpAddress = await getServiceIp(entry);
    return changeSets.filter(
      (changeSet) => changeSet.origin != originIpAddress
    );
  }
}

function hostnameForEntry(entry) {
  return new URL(entry.callback.url).hostname;
}

async function getServiceIp(entry) {
  const hostName = hostnameForEntry(entry);
  return new Promise((resolve, reject) => {
    dns.lookup(hostName, { family: 4 }, (err, address) => {
      if (err) reject(err);
      else resolve(address);
    });
  });
}
