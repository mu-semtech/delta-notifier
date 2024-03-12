import { sendRequest } from "./send-request.js";
import { createHash } from "node:crypto";

// map from bundle key to bundle object
const bundles = {};

const getBundleKey = (entry, muSessionId, changeSets) => {
  if (entry.options.preciseBundling) {
    // more precise regarding allowed groups BUT slower since we're hashing a possibly longish string
    const hash = createHash("sha256");

    const allowedGroups = changeSets[0].allowedGroups;
    hash.update(allowedGroups);
    return `${entry.index}-${muSessionId}-${hash.digest("hex")}`;
  } else {
    return `${entry.index}-${muSessionId}`;
  }
  // should bundle with session id because SEAS sessions should be respected when handling deltas
};

const executeBundledRequest = (bundleKey) => {
  const bundle = bundles[bundleKey];
  delete bundles[bundleKey];

  if (!bundle) {
    console.error(
      `Bundle for key ${bundleKey} unexpectedly got handled already.`
    );
    return;
  }

  sendRequest(
    bundle.entry,
    bundle.originFilteredChangeSets,
    bundle.muCallIdTrail,
    bundle.muSessionId,
    {
      "mu-bundled-call-id-trails": bundle.bundledCallIdTrails.join(","),
    }
  );
};

export const sendBundledRequest = (
  entry,
  originFilteredChangeSets,
  muCallIdTrail,
  muSessionId
) => {
  const bundleKey = getBundleKey(entry, muSessionId, originFilteredChangeSets);
  const existingBundle = bundles[bundleKey];

  if (existingBundle) {
    // change sets in bundle are simply added to the existing bundle, have client remove noops from it if desired
    // as we don't know if noops are of interest to the client and we shouldn't judge
    existingBundle.originFilteredChangeSets = [
      ...bundles[bundleKey].originFilteredChangeSets,
      ...originFilteredChangeSets,
    ];
    existingBundle.bundledCallIdTrails.push(muCallIdTrail);
    // since an existing bundle exists, we don't need to send it after timeout,
    // the existing bundle will send us too
    if (process.env["DEBUG_DELTA_SEND"]) {
      console.log(
        `Adding to bundle for key ${bundleKey}, now contains ${existingBundle.originFilteredChangeSets.length} change sets`
      );
    }
  } else {
    if (process.env["DEBUG_DELTA_SEND"]) {
      console.log(
        `Creating bundle for key ${bundleKey}, sending in ${entry.options.gracePeriod}ms`
      );
    }
    bundles[bundleKey] = {
      entry,
      originFilteredChangeSets,
      muCallIdTrail,
      muSessionId,
      bundledCallIdTrails: [],
    };
    setTimeout(
      () => executeBundledRequest(bundleKey),
      entry.options.gracePeriod
    );
  }
};
