import serverless from 'serverless-http';
import { app } from '../../server.js';

// Wrap the Express app with serverless-http
export const handler = serverless(app, {
  binary: ['image/*', 'application/octet-stream']
});

