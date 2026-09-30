import { httpRouter } from 'convex/server';
import { authComponent, createAuth } from './auth';

const http = httpRouter();

authComponent.registerRoutes(http, createAuth, {
  cors: { allowedOrigins: [process.env.SITE_URL!] },
});

export default http;
