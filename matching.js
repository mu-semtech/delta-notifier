import dns from 'dns';
import { DEBUG_TRIPLE_MATCHES_SPEC } from './env';
/**
 * Filters the change sets based on a specified pattern.
 *
 * @param {Array<Object>} changeSets - An array of change set objects,
 * each containing `insert` and `delete` properties.
 * @param {Object} entry - An object containing the matching criteria.
 * @param {Array} entry.match - The pattern(s) used to filter the triples
 * in the `insert` and `delete` arrays.
 * @returns {Array<Object>} A new array of change set objects with
 * filtered `insert` and `delete` properties.
 */
export function filterChangesetsOnPattern(changeSets, entry) {
  const filteredChangesets = [];
  for (const changeSet of changeSets) {
    const { insert, delete: deleteSet, effectiveInsert, effectiveDelete } = changeSet;
    const clonedChangeSet = {
      ...changeSet,
      insert: insert.filter((triple) => tripleMatchesSpec(triple, entry.match)),
      delete: deleteSet.filter((triple) => tripleMatchesSpec(triple, entry.match)),
      effectiveInsert: effectiveInsert.filter((triple) => tripleMatchesSpec(triple, entry.match)),
      effectiveDelete: effectiveDelete.filter((triple) => tripleMatchesSpec(triple, entry.match)),
    };
    filteredChangesets.push(clonedChangeSet);
  };
  return filteredChangesets;
}


export function tripleMatchesSpec( triple, matchSpec ) {
  const matches = Array.isArray(matchSpec) ? matchSpec : [matchSpec];
  if(DEBUG_TRIPLE_MATCHES_SPEC)
    console.log(`Does ${JSON.stringify(triple)} match ${JSON.stringify(matchSpec)}?`);

  return matches.some((match) => tripleMatchesPattern(triple, match));
}

function tripleMatchesPattern( triple, pattern ) {
  // form of triple is {s, p, o} or {subject, predicate, object}, same as pattern
  for( let key in pattern ){
    // key is one of subject, predicate, object
    const subMatchSpec = pattern[key];
    const subMatchValue = triple[key];

    if( subMatchSpec && !subMatchValue )
      return false;

    for( let subKey in subMatchSpec )
      // we're now matching something like {type: "url", value: "http..."}
      if( subMatchSpec[subKey] !== subMatchValue[subKey] )
        return false;
  }
  return true; // no false matches found
}


export async function filterMatchesForOrigin( changeSets, entry ) {
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

export function hostnameForEntry( entry ) {
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
