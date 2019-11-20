const path = require('path');

const getExpectationsFilename = taskData => {
  const { spec, testName } = taskData;
  const basename = `${spec}__${testName}`;
  const fixtures = path.join(__dirname, '..', 'fixtures');
  const filename = path.join(fixtures, `${basename}.json`);

  return filename;
};

const transformRecordedData = (expectation, requestBodySanitizer, responseBodySanitizer) => {
  const { httpRequest, httpResponse } = expectation;

  const responseHeaders = {};

  Object.keys(httpResponse.headers).forEach(key => {
    responseHeaders[key] = httpResponse.headers[key][0];
  });

  let queryString;
  if (httpRequest.queryStringParameters) {
    const { queryStringParameters } = httpRequest;

    queryString = Object.keys(queryStringParameters)
      .map(key => `${key}=${queryStringParameters[key]}`)
      .join('&');
  }

  const body = requestBodySanitizer(httpRequest);
  const responseBody = responseBodySanitizer(httpRequest, httpResponse);

  const cypressRouteOptions = {
    body,
    method: httpRequest.method,
    url: queryString ? `${httpRequest.path}?${queryString}` : httpRequest.path,
    headers: responseHeaders,
    response: responseBody,
    status: httpResponse.statusCode,
  };

  return cypressRouteOptions;
};

module.exports = {
  getExpectationsFilename,
  transformRecordedData,
};
