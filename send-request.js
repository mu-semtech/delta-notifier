import http from "http";
import { uuid } from "mu";

const MAX_RETRIES = process.env.MAX_RETRIES || 3;
const RETRY_TIMEOUT = process.env.RETRY_TIMEOUT || 250;

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
  muSessionId,
  extraHeaders = {},
  retries = MAX_RETRIES
) {
  // construct the requestObject
  const method = entry.callback.method;
  const url = entry.callback.url;
  const headers = {
    ...extraHeaders,
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
      throw new Error(`failed to send request, status: ${response.status}`);
    }
  } catch (error) {
    console.log(`Could not send request ${method} ${url}`);
    console.log(error);

    if (retries > 0) {
      const livesLeft = retries - 1;
      console.log(`RETRYING (${livesLeft} left)`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_TIMEOUT));
      await sendRequest(
        entry,
        changeSets,
        muCallIdTrail,
        muSessionId,
        extraHeaders,
        livesLeft
      );
    } else {
      console.log(`NOT RETRYING`);
    }
  }
}
