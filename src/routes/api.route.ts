import express from 'express';
const routes = express.Router();

import stockControllerApi from './stock.route';
import clickupApi from './clickup.route';
import clickupVifApi from './vif.route';
import xeroApi from './xero.auth.route';
import xeroBillApi from './xero.bill.route';
import xeroQuoteWebhookApi from './Xero.quotewebhook.route';
import apiCheck from './api.check.route';
import server from './server.route';
import businessUnit from './xero.businessUnit.route';
import poUnit from './xero.purchaseorder.route';

// Secured routes (apiKeyAuth + rate limit + Zod validation via @Route decorator)
import xeroQuoteSecuredApi from './secured/xero.quote.secured.route';

routes.use('/api/v1', xeroBillApi); // Most specific first — Xero INVOICE webhook (HMAC signed)
routes.use('/api/v1', xeroQuoteWebhookApi); // Xero QUOTE webhook (HMAC signed)
routes.use('/api/v1', stockControllerApi); // ClickUp webhook
routes.use('/api/v1', clickupApi); // ClickUp webhook
routes.use('/api/v1', clickupVifApi); // ClickUp webhook
routes.use('/api/v1/xero', xeroApi); // OAuth redirect/callback — unauthenticated by design
routes.use('/api/v1/xero', xeroQuoteSecuredApi); // Frontend-facing — secured
routes.use('/api/v1/check', apiCheck);
routes.use('/api/v1', businessUnit); // ClickUp webhook
routes.use('/api/v1', poUnit); // ClickUp webhook
routes.use('/', server);

export default routes;
