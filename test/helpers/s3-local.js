'use strict';

// Test-only preload (node --require). Points aws-sdk at a local S3 fake
// (e.g. adobe/s3mock or MinIO) so a backup run never talks to real AWS.
const endpoint = process.env.TEST_S3_ENDPOINT;

if (!endpoint) {
  throw new Error('TEST_S3_ENDPOINT must be set when preloading test/helpers/s3-local.js');
}

const AWS = require('aws-sdk');

AWS.config.update({
  endpoint,
  s3ForcePathStyle : true,
  sslEnabled       : endpoint.startsWith('https:'),
});
