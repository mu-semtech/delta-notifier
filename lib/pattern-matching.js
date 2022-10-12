import { querySudo as query } from '@lblod/mu-auth-sudo';
import { sparqlEscapeUri, sparqlEscapeString } from 'mu';

class PatternMatching {
  // Constraints for the solution (matches in the configuration)
  //
  // Array of which each element is one triple specification.
  patterns = [];

  // Bindings: mapping of variables to rdf terms
  bindings = {};

  /**
   * These bindings contain a single pattern and a set of variable
   * bindings.
   *
   * Major is to be interpreted as them containing a single
   * triple coming from the delta message which yields a solution.  This
   * single triple means that any solution that can be found from this
   * starting point may be of interest to consumers.
   *
   * These could be considered the starting points for the patterns to
   * discover in the full dataset available to us.
   *
   * In case we later start to understand functional properties (or
   * similar constraints) then these major bindings we can fold this and
   * it may contain multiple patterns and multiple bindings.
   */
  majorBindings = [];

  // // Patterns for which we have found a complete match
  // matchedPatterns = [];

  // // Patterns for which we have not found a complete solution
  // incompletePatterns = [];

  /**
     * New PatternMatching
     *
     * @param {[]} patterns What we are looking for.
     */
  constructor(patterns) {
    this.patterns = patterns;
  }

  get variableNames() {
    return [...new Set(this
      .patterns
      .flatMap(variablesOfPattern)
      .map(variableName)
    )];
  }

  /**
   * Fill in bindings for changed triples.  Any found binding may lead
   * to a query solution.
   *
   * @param {[]} triples Recently changed content.
   *
   * @return {PatternMatching} self
   */
  setupBindings(triples) {
    this.majorBindings =
      this.patterns.flatMap((pattern) =>
        triples.flatMap((triple) => {
          const bindings = extractVariableBindingsForTripleAndPattern(triple, pattern);
          return bindings == null
            ? []
            : [{ pattern, bindings }];
        }));

    return this;
  }

  // get isComplete() {
  //   return this.incompletePatterns.length == 0;
  // }

  // get incompletePatternsWithAvailableBindings() {
  //   return this
  //     .incompletePatterns
  //     .filter((pattern) =>
  //       variablesOfPattern(pattern)
  //         .some((variable) =>
  //           this.hasBindingForVariable(variable)));
  // }

  // fillInIncompletePatterns() {
  //   let nextBindings;
  //   while ((nextBindings = this.incompletePatternsWithAvailableBindings)) {
  //     // TODO: NEXT
  //     // search delta store
  //     // search triplestore
  //   }
  // }

  async extractSolutions() {
    // TODO: consider access rights of current delta message on requesting extra information
    let solutions = [];

    for (const { pattern, bindings } of this.majorBindings) {
      // TODO: handle solutions through:
      // - current delta message
      // - recent inserts
      // - recent deletes
      const bindingsValueStatement =
        bindings
          .map(({ name: variable, value: binding }) =>
            `VALUES ?${variable} { ${termSparqlValue(binding)} }`
          )
          .join("\n");

      const triplePatterns =
        this
          .patterns
          .filter((p) => p !== pattern) // exclude pattern matched
          // through variable bindings
          .map(({ subject, predicate, object }) => {
            // TODO: maybe support graph
            const asSparql = (term) => {
              if (!term) {
                return makeSparqlVar();
              } else {
                if (rdfTermIsVariable(term)) {
                  return `?${variableName(term)}`;
                } else {
                  return termSparqlValue(term);
                }
              }
            };
            return `\n    ${asSparql(subject)} ${asSparql(predicate)} ${asSparql(object)}.`;
          });

      const { results: { bindings: extraTriplesNative } } =
        await query(`
              CONSTRUCT {
                ${triplePatterns}
              } WHERE {
                ${triplePatterns}
                ${bindingsValueStatement}
              }`);

      const extraTriples = extraTriplesNative.map(({ s, p, o }) => ({ subject: s, predicate: p, object: o }));
      // Approach for detecting all possibilities from this match:
      // - we walk down each triple and fill in variable bindings
      // - if the binding is incompatible, we add the triple as a new
      //   starting point with the
      let availableTriples = extraTriples; // TODO: will be extended with other available triples
      let nextStartingPoints = new Set(availableTriples.length ? [availableTriples[0]] : []);
      let visitedStartingPoints = new Set();
      let possibleSolutions = new Set(); // these may not be complete
      // exclude pattern matched through variable bindings
      let patternsToMatch = this
        .patterns
        .filter((p) => p !== pattern);

      let discoveredBindingCombinations = [];

      const discoverSolutionsFrom = (bindings, triples, onConflict) => {
        if (triples.length == 0) {
          return [bindings];
        } else {
          const [triple, ...restTriples] = triples;
          return patternsToMatch
            .map((p) => extractVariableBindingsForTripleAndPattern(triple, p))
            .filter((solutions) => solutions !== null)
            .flatMap((bindingsOfTriple) => {
              const newBindings = combineBindings(bindingsOfTriple, bindings);
              if (newBindings) {
                // continue with next triples
                return discoverSolutionsFrom(newBindings, restTriples, onConflict);
              } else {
                // this is a conflict
                onConflict(triple);
                return discoverSolutionsFrom(bindings, restTriples, onConflict);
              }
            });
        }
      };

      while (nextStartingPoints.size) {
        // init
        const startingPoints = [...nextStartingPoints];
        nextStartingPoints.clear();
        for (const startingPoint of startingPoints) {
          visitedStartingPoints.add(startingPoint);
          // walk the tree of possible solutions
          const solutions =
            discoverSolutionsFrom(
              bindings,
              availableTriples,
              (triple) => {
                if (!visitedStartingPoints.has(triple))
                  nextStartingPoints.add(triple);
              });
          discoveredBindingCombinations = [
            ...solutions,
            ...discoveredBindingCombinations
          ];
        }
      }

      const completeBindings =
        discoveredBindingCombinations
          .filter((combination) =>
            this.variableNames.every((name) =>
              combination.some((binding) =>
                bindingVariableName(binding) == name)));

      solutions = [...completeBindings, ...solutions];
    }

    return solutions;
  }

  // /**
  //  * Complete the incomplete patterns with bindings from deltaStore.
  //  *
  //  * Note: in order to complete, we can't add new values for bindings
  //  * which were found in the initial delta.
  //  *
  //  * @return {PatternMatching} self
  //  */
  // completeWithRecentDeltas(deltaStore) {
  //   if (this.matchedPatterns.length) {
  //     const bindings =
  //       this.incompletePatterns
  //         .flatMap((pattern) =>
  //           deltaStore.flatMap((triple) =>
  //             extractVariableBindingsForTripleAndPattern(triple, pattern)));

  //     // ?person a foaf:Person; foaf:name ?name; foaf:mbox ?mbox.
  //     // ?mbox a ext:SpecialMailBox.

  //     //

  //   }

  //   return this;
  // }

  /**
   * Yields truethy if we have a binding for the variable with the given name.
   *
   * @param {string} name Name of the variable.
   * @return {boolean} True iff we have at least one binding for the
   * variable.
   */
  hasBindingForVariable(name) {
    return this.bindings.some((binding) => binding.name === name);
  }

  // /**
  //  * Takes existing patterns and redistributes them across
  //  * matchedPatterns and incompletePatterns based on current bindings.
  //  */
  // redistributePatterns(triples) {
  //   // helpers
  //   const allVariablesBoundP = function (pattern) {
  //     return Object.keys(pattern)
  //       .every((key) =>
  //         !rdfTermIsVariable(pattern[key])
  //         || this.hasBindingForVariable(variableName(pattern[key])));
  //   };

  //   const patternCompleteP = function (pattern) {
  //     return triples.some((triple) => singleTripleMatchesPattern(triple, pattern))
  //       && allVariablesBoundP(pattern);
  //   };

  //   // calculation
  //   const [matchedPatterns, incompletePatterns] =
  //     this.patterns.reduce(([matched, incomplete], pattern) =>
  //       patternCompleteP(pattern)
  //         ? [[pattern, ...matched], incomplete]
  //         : [matched, [pattern, ...incomplete]]);

  //   // update internal state
  //   this.matchedPatterns = matchedPatterns;
  //   this.incompletePatterns = incompletePatterns;
  // }
}

/////////////////////////
//// Supporting functions

/**
 * Yield bindings for variables.
 *
 * @return If the triple does not match the pattern, null is returned.
 * If the triple matches the pattern, an array of bindings is returned.
 * If there are no variables but the triple matches, this array will be
 * empty.
 */
function extractVariableBindingsForTripleAndPattern(triple, pattern) {
  // TODO: cope with inconsistencies when the same variable is repeated
  // multiple times.
  if (singleTripleMatchesPattern(triple, pattern)) {
    return Object
      .entries(pattern)
      .map(([key, rdfTerm]) =>
        rdfTermIsVariable(rdfTerm)
          ? makeVariableBinding(variableName(rdfTerm), triple[key])
          : null)
      .filter((item) => item !== null);
  } else {
    return null;
  }
}

function singleTripleMatchesPattern(triple, matchSpec) {
  // form of triple is {subject, predicate, object, graph}, same as matchSpec
  if (process.env["DEBUG_TRIPLE_MATCHES_SPEC"])
    console.log(`Does ${JSON.stringify(triple)} match ${JSON.stringify(matchSpec)}?`);

  for (let key in matchSpec) {
    // key is one of subject, predicate, object, graph
    const subMatchSpec = matchSpec[key];
    const subMatchValue = triple[key];

    if (!rdfTermIsVariable(subMatchSpec)) {
      // TODO: this should be replaced with a sanity check at configuration time for valid keys of match.
      //
      // subMatchValue will always exist for all sane keys, hence we can
      // check sanity on startup and drop this case.
      if (subMatchSpec && !subMatchValue)
        return false;

      for (let subKey in subMatchSpec)
        // we're now matching something like {type: "url", value: "http..."}
        if (subMatchSpec[subKey] !== subMatchValue[subKey])
          return false;
    }
  }
  return true; // no false matches found, let's send a response
}

/**
 * Combines multiple bindings into a compatible set or yields null.
 *
 * Does not manipulate left or right but rather returns a new set of
 * bindings.
 */
function combineBindings(left, right) {
  let solution = [...left];

  for (const { name, value } of right) {
    let existingBinding = solution.find(({ name: leftName }) => name === leftName);
    if (existingBinding && !termEqual(existingBinding.value, value)) // conflicting variable binding in left and right
      return null;
    else if (existingBinding) // matching variable binding. No new info.
      solution = solution;
    else // new variable binding found in right
      solution = [{ name, value }, ...solution];
  }

  return solution;
}

/**
 * Return truethy iff left and right represent the same term.
 */
function termEqual(left, right) {
  return [...new Set(...Object.keys(left), Object.keys(right))]
    .every((key) => left[key] === right[key]);
}

//////////////////////
//// Data abstractions

/**
 * Construct a new variable binding.
 *
 * This connects a variable to its value.
 */
function makeVariableBinding(name, value) {
  return { name, value };
}

/**
 * Return the name of the variable binding.
 */
function bindingVariableName({name}) {
  return name;
}

/**
 * Does the pattern have a variable?
 */
function patternHasVariable(pattern) {
  return Object.keys(pattern).some((key) => rdfTermIsVariable(pattern[key]));
}

/**
 * Yields the rdfTerm specifications for each variable of pattern
 */
function variablesOfPattern(pattern) {
  return Object.values(pattern).filter(rdfTermIsVariable);
}

/**
  * term represents a variable.
  */
function rdfTermIsVariable(term) {
  return term.type === "variable";
}

/**
 * Yields the variable name of term.  Errors if it is not a variable.
 */
function variableName(term) {
  if (rdfTermIsVariable(term))
    return term.value;
  else
    throw `Term ${term} is not an rdfTerm variable.`;
}

///////////////////
//// Sparql helpers
function termSparqlValue({ value, type, datatype }) {
  if (type === "uri") {
    return sparqlEscapeUri(value);
  } else {
    if (!datatype || datatype === "string") {
      return sparqlEscapeString(value);
    } else {
      return `${sparqlEscapeString(value)}^^${sparqlEscapeUri(datatype)}`;
    } // TODO: Support language typed strings
  }
}

let next = 0;
function makeSparqlVar(label = "var") {
  return `?_${label}${next++}`;
}

////////////
//// Exports

export default async function discoverBindings(triples, patterns) {
  return await (new PatternMatching(patterns))
    .setupBindings(triples)
    .extractSolutions();
}
