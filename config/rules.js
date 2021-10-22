export default [
  {
    match: {
      // form of element is {subject,predicate,object}
      predicate: { type: "uri", value: "http://www.semanticdesktop.org/ontologies/2007/03/22/nmo#isPartOf" }
    },
    callback: {
      uri: "http://maildelivery/send", method: "PATCH"
    }
  },
  {
    match: {
      subject: {
        ask: "?org <http://www.w3.org/ns/adms#identifier> ?identifier. ?identifier <https://data.vlaanderen.be/ns/generiek#gestructureerdeIdentificator> {{this}}"
      },
      predicate: {
        type: 'uri',
        value: 'https://data.vlaanderen.be/ns/generiek#lokaleIdentificator'
      }
    },
    callback: {
      url: "http://kalliope-api/delta",
      method: "POST"
    },
    options: {
      resourceFormat: "v0.0.1",
      gracePeriod: 1000,
      ignoreFromSelf: true
    }
  }
];
