import http from "http";
import { uuid } from "mu";

function formatChangesetBody(changeSets, options) {
  if (options.resourceFormat == "v0.0.1") {
    return JSON.stringify(
      changeSets.map((change) => {
        return {
          inserts: change.insert,
          deletes: change.delete,
        };
      })
    );
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

export async function sendRequest(
  entry,
  changeSets,
  muCallIdTrail,
  muSessionId
) {
  let requestObject; // will contain request information

  // construct the requestObject
  const method = entry.callback.method;
  const url = entry.callback.url;
  const headers = {
    "Content-Type": "application/json",
    "MU-AUTH-ALLOWED-GROUPS": changeSets[0].allowedGroups,
    "mu-call-id-trail": muCallIdTrail,
    "mu-call-id": uuid(),
    "mu-session-id": muSessionId,
  };

  let body;
  if (entry.options && entry.options.resourceFormat) {
    // we should send contents
    body = formatChangesetBody(changeSets, entry.options);
  }
  if (process.env["DEBUG_DELTA_SEND"])
    console.log(`Executing send ${method} to ${url}`);
  try {
    const keepAliveAgent = new http.Agent({
      keepAlive: true,
    });
    const response = await fetch(url, {
      method,
      headers,
      body,
      agent: keepAliveAgent,
    });
    if (!response.ok) {
      console.log(
        `Call to ${method} ${url} likely failed. Received status ${response.status}.`
      );
    }
  } catch (error) {
    console.log(`Could not send request ${method} ${url}`);
    console.log(error);
    console.log(`NOT RETRYING`); // TODO: retry a few times when delta's fail to send
  }
}
