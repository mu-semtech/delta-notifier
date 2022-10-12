export default [
  {
    match: [
      {
        subject: { type: "variable", value: "person" },
        // form of element is {subject,predicate,object}
        predicate: { type: "uri", value: "http://www.semanticdesktop.org/ontologies/2007/03/22/nmo#isPartOf" }
      }
    ],
    callback: {
      uri: "http://maildelivery/send", method: "PATCH"
    }
  }
];
