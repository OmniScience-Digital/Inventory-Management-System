import fetch from 'node-fetch';
import FormData from 'form-data';
import { getAccessToken } from '../helper/tokens/token.helper';
import { ClickUpTaskResponse, Quote, XeroQuotesResponse } from '../schema/xero.schema';
import logger from '../utils/logger';
import { getXeroConfig, updateXeroConfig } from '../repositories/dynamo.xeroconfig.repository';
import {
  createQuote,
  updateQuote,
  getQuoteByNumber,
} from '../repositories/dynamo.quote.repository';
import { getClickUpTask } from './clickUpfetch.service';
import { buildSteps, buildContentChangeSteps, QuoteStep } from './quoteTransition';

const TENANT_ID = process.env.XERO_TENANT_ID!;
const API_TOKEN = process.env.CLICKUP_API_TOKEN!;
const Xero_Url = process.env.Xero_Url!;

const CUSTOMER_FIELD_ID = 'b1b8b307-162d-46b6-8dbb-6e995d1130bc';
const PO_NUMBER_FIELD_ID = '7830276e-f1bb-4efc-8e87-e34693cbd712';
const BUSINESS_UNIT_FIELD_ID = 'fdf29394-d070-4384-863c-9f2f5885061f';

// Task Relationship custom fields - link a task back to CRM-01/02/33, per diagram.
const CRM01_LINK_FIELD_ID = 'c6985922-9163-4b5e-ae07-68cb430c1e20';
const CRM02_LINK_FIELD_ID = '8e729043-bea0-46b1-8f5c-3eddb5dc4cc3';
const CRM33_LINK_FIELD_ID = 'f5742565-963a-4ab7-b74d-63c7b12b795d';

// Builds a ClickUp URL custom field entry, or null if there's no task to link yet
// (e.g. CRM-01 not created yet) - null entries get filtered out.
// Confirmed via FIELD_010 "Value is not a valid URL": these are plain URL fields,
// not Task Relationship fields - so we send the task's URL as a string.
function taskLinkField(fieldId: string, taskId?: string): { id: string; value: any } | null {
  if (!taskId) return null;
  return { id: fieldId, value: `https://app.clickup.com/t/${taskId}` };
}

// New job-card lists (replaces the old single CRM5 list). One of these four is chosen
// on Accepted based on: PO = "#INTPO..." (internal PO) -> CRM-051, otherwise -> CRM-050,
// then split again by Business Unit (Global / Services).
const CRM050_GLOBAL_LIST_ID = process.env.CRM050_GLOBAL_LIST_ID!;
const CRM050_SERVICES_LIST_ID = process.env.CRM050_SERVICES_LIST_ID!;
const CRM051_GLOBAL_LIST_ID = process.env.CRM051_GLOBAL_LIST_ID!;
const CRM051_SERVICES_LIST_ID = process.env.CRM051_SERVICES_LIST_ID!;

// crm-033-999-declined-aka-cold-storage and crm-032-999-quote-lost-job-card-group
// are single lists each (not split by Business Unit).
const CRM033_LIST_ID = process.env.CRM033_LIST_ID!;
const CRM032_LIST_ID = process.env.CRM032_LIST_ID!;

// Internal PO syntax example: #INTPO-SF-260819-02C, #INTPO-GD-260820-03T
const INTERNAL_PO_PREFIX = '#INTPO';

// Same Business Unit option IDs used in xero.businessUnit.controller.ts.
// That controller guarantees businessUnitvalueid is always one of these two
// once it has run - but a quote can reach ClickUp task creation *before*
// the Business Unit webhook has ever fired (businessUnitvalueid === '').
// ClickUp rejects an empty string for a dropdown field (FIELD_011), so we
// must always send a valid option id - default to Services, same as
// xeroBusinessUnitController does.
const GLOBAL_BUSINESS_UNIT_ID = 'f0dec408-0e75-4248-aed4-282b2ca74fce'; // Global
const SERVICES_BUSINESS_UNIT_ID = 'a6ce6bb6-123f-4c9d-b964-dfdb6d4e95ad'; // Services (default)

function safeBusinessUnitId(quote: any): string {
  return quote?.businessUnitvalueid || SERVICES_BUSINESS_UNIT_ID;
}

// Maps each of the 4 job-card branches to its ClickUp list and its exact DB field name
// (must match the Quote model in the Amplify schema, data-resource.ts, field-for-field).
const JOB_CARD_BRANCHES = {
  CRM050_GLOBAL: { listId: CRM050_GLOBAL_LIST_ID, dbField: 'clickUpTaskidCRM050_Global' },
  CRM050_SERVICES: { listId: CRM050_SERVICES_LIST_ID, dbField: 'clickUpTaskidCRM050_SERVICES' },
  CRM051_GLOBAL: { listId: CRM051_GLOBAL_LIST_ID, dbField: 'clickUpTaskidCRM051_GLOBAL' },
  CRM051_SERVICES: { listId: CRM051_SERVICES_LIST_ID, dbField: 'clickUpTaskidCRM051_SERVICES' },
} as const;
type JobCardBranchKey = keyof typeof JOB_CARD_BRANCHES;

/**
 * Picks which of the 4 job-card branches (and therefore which DB field / ClickUp list)
 * a new job card should use.
 *
 * NOTE: at the moment a quote is Accepted, quote.PoNumber is normally still empty -
 * it only gets filled in later, once sales manually enters it on CRM-02 (see
 * xero.purchaseorder.controller.ts / poUpdate). Until that's resolved with Shaughn,
 * an empty PO number will fall through to the "not internal" (CRM-050) branch below.
 */
function resolveJobCardBranch(quote: any): JobCardBranchKey {
  const poNumber = (quote?.PoNumber || '').toString().trim().toUpperCase();
  const isInternalPO = poNumber.startsWith(INTERNAL_PO_PREFIX);

  // Business Unit is set via xeroBusinessUnitController, which always resolves to
  // Global or Services (defaulting to Services) - so we compare by ID, not name.
  const isGlobal = quote?.businessUnitvalueid === GLOBAL_BUSINESS_UNIT_ID;

  if (isInternalPO) {
    return isGlobal ? 'CRM051_GLOBAL' : 'CRM051_SERVICES';
  }
  return isGlobal ? 'CRM050_GLOBAL' : 'CRM050_SERVICES';
}

// Returns whichever of the 4 job-card fields is populated for this quote, if any.
// Only one branch is ever used per quote (see resolveJobCardBranch), so this is safe.
export function getJobCardTaskId(quote: any): string | undefined {
  for (const { dbField } of Object.values(JOB_CARD_BRANCHES)) {
    if (quote[dbField]) return quote[dbField];
  }
  return undefined;
}

export async function pollQuotes() {
  try {
    const config = await getXeroConfig(TENANT_ID);
    let lastUpdatedDateUTC: string | null = config?.quotesLastSyncUTC ?? null;

    const ACCESS_TOKEN = await getAccessToken();
    const payload = JSON.parse(Buffer.from(ACCESS_TOKEN.split('.')[1], 'base64url').toString());
    logger.info(`[Xero] Token scopes: ${payload.scope}`);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'xero-tenant-id': TENANT_ID,
      Accept: 'application/json',
    };
    if (lastUpdatedDateUTC) {
      headers['If-Modified-Since'] = new Date(lastUpdatedDateUTC).toUTCString();
    }

    let page = 1;
    let allQuotes: Quote[] = [];

    while (true) {
      const url = `https://api.xero.com/api.xro/2.0/Quotes?order=UpdatedDateUTC DESC&page=${page}&pageSize=100`;

      const res = await fetch(url, { method: 'GET', headers });

      if (res.status === 304) {
        console.log('No new or updated quotes.');
        return;
      }

      if (res.status === 429) {
        logger.warn('[Xero] Rate limit hit, skipping this poll cycle');
        return;
      }

      if (!res.ok) {
        const errBody = await res.text();
        logger.error(`[Xero] Failed to fetch quotes (${res.status} ${res.statusText}): ${errBody}`);
        throw new Error(`Failed to fetch quotes: ${res.status} ${res.statusText}`);
      }

      const data = (await res.json()) as XeroQuotesResponse;

      if (!data.Quotes || data.Quotes.length === 0) {
        break;
      }

      allQuotes = allQuotes.concat(data.Quotes);

      if (data.Quotes.length < 100) {
        break;
      }

      page++;
    }

    if (allQuotes.length === 0) {
      console.log('No quotes found.');
      return;
    }
    logger.info(`✅ Total Quotes  Retrieved: ${allQuotes.length}`);
    logger.info('Last Sync Used:', lastUpdatedDateUTC);
    logger.info('--------------------------------------------');

    for (const quote of allQuotes) {
      const rawTimestamp = quote.UpdatedDateUTC.replace(/\/Date\((\d+)\)\//, '$1');
      const updatedISO = new Date(parseInt(rawTimestamp)).toISOString();
      if (!lastUpdatedDateUTC || new Date(updatedISO) > new Date(lastUpdatedDateUTC)) {
        await handleQuoteStatuses(quote);
      }
    }

    // Update lastUpdatedDateUTC to newest record (keep in UTC for comparison)
    const newestQuote = allQuotes.reduce((prev, curr) => {
      const prevDate = new Date(prev.UpdatedDateUTC.replace(/\/Date\((\d+)\)\//, '$1'));
      const currDate = new Date(curr.UpdatedDateUTC.replace(/\/Date\((\d+)\)\//, '$1'));
      return currDate > prevDate ? curr : prev;
    });

    const newestRaw = newestQuote.UpdatedDateUTC.replace(/\/Date\((\d+)\)\//, '$1');
    const newestSync = new Date(parseInt(newestRaw)).toISOString();

    await updateXeroConfig(TENANT_ID, { quotesLastSyncUTC: newestSync });
    logger.info('🕒 New Quote Order SyncTimestamp Stored:', newestSync);
  } catch (err) {
    console.error('❌ Error polling quotes:', err);
  }
}

export async function handleQuoteStatuses(quote: Quote) {
  const existingQuote = await getQuoteByNumber(quote.QuoteNumber);

  const quoteIssueDate = quote.DateString
    ? new Date(quote.DateString).toISOString()
    : new Date().toISOString();

  const quoteExpireyDate = quote.ExpiryDateString
    ? new Date(quote.ExpiryDateString).toISOString()
    : new Date().toISOString();

  // ─── "Does not exist": brand-new quote (no DB row) ────────────────────────
  // Xero may already have moved it past DRAFT before our first poll ever saw
  // it. Replay every step from 'Created' up to the current poll status so no
  // ClickUp artifact is skipped.
  if (!existingQuote) {
    const newItem: any = {
      id: `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
      quoteId: quote.QuoteID,
      quoteNumber: quote.QuoteNumber,
      quoteReference: quote.Reference || '',
      customerID: quote.Contact?.ContactID || '',
      customerName: quote.Contact?.Name || '',
      quoteIssueDate,
      quoteExpireyDate,
      title: quote.Title || quote.QuoteNumber + ', ' + quote.Contact?.Name + ', ' + quote.Reference,
      PoNumber: '',
      quoteStatus: quote.Status || '',
      currencyCode: quote.CurrencyCode || '',
      lineItems: quote.LineItems || [],
      subTotal: quote.SubTotal || 0,
      taxTotal: quote.TotalTax || 0,
      quTotal: quote.Total || 0,
      invNumber: '',
      quoteAction: 'Created',
      businessUnitvalueid: '',
      businessUnitvalue: '',
      clickUpTaskidCrm1: '',
      clickUpTaskidCrm2: '',
      clickUpTaskidCrm5: '',
      clickUpTaskidCrm7: '',
      clickUpTaskidCrm9: '',
      clickUpTaskidCRM050_Global: '',
      clickUpTaskidCRM050_SERVICES: '',
      clickUpTaskidCRM051_GLOBAL: '',
      clickUpTaskidCRM051_SERVICES: '',
      clickUpTaskidCRM032: '',
      clickUpTaskidCRM033: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const steps = buildSteps(null, quote.Status || 'DRAFT');

    // Sequential replay - later steps read task IDs that earlier steps stored
    // on newItem. Deliberately a loop, not recursion.
    for (const step of steps) {
      await applyQuoteStep(newItem, step);
    }

    // quoteAction reflects the final state reached, not just 'Created'.
    newItem.quoteAction = steps[steps.length - 1] ?? 'Created';

    await createQuote(newItem);
    logger.info(`Quote ${quote.QuoteNumber} processed (new) with steps: ${steps.join(' -> ')}`);
    return;
  }

  // ─── Existing quote: compare DB status vs poll status, replay missing steps ──
  const lineItemsChanged =
    JSON.stringify(existingQuote.lineItems) !== JSON.stringify(quote.LineItems);

  const totalsChanged =
    existingQuote.subTotal !== quote.SubTotal ||
    existingQuote.taxTotal !== quote.TotalTax ||
    existingQuote.quTotal !== quote.Total;

  let steps: QuoteStep[];

  if (quote.Status !== existingQuote.quoteStatus) {
    const prevStatus = existingQuote.quoteStatus;
    logger.info(
      `Quote ${quote.QuoteNumber} status change detected: ${prevStatus} -> ${quote.Status}`
    );

    steps = buildSteps(prevStatus, quote.Status);

    if (steps.length === 0) {
      // Unknown/unmodelled transition. Log loudly and leave the DB row
      // untouched rather than throwing - one weird quote must not block the
      // rest of the poll loop.
      logger.warn(
        `Quote ${quote.QuoteNumber}: unhandled transition ${prevStatus} -> ${quote.Status}. ` +
          `DB row left unchanged. Add this pair to quoteTransition.ts if it is legitimate.`
      );
      return;
    }
  } else if (lineItemsChanged || totalsChanged) {
    // Xero's Status field stays ACCEPTED/DECLINED forever once reached - it never
    // flips back to SENT just because the quote was resent. So a resend of an
    // already-Accepted or already-Declined quote only ever shows up here, as a
    // "something changed" fallback, not as a Status transition above.
    steps = buildContentChangeSteps(existingQuote.quoteStatus);
  } else {
    logger.info(`No changes for quote ${quote.QuoteNumber}`);
    return;
  }

  const updates: any = {
    quoteNumber: quote.QuoteNumber,
    quoteReference: quote.Reference,
    customerID: quote.Contact?.ContactID || '',
    customerName: quote.Contact?.Name || '',
    quoteIssueDate,
    quoteExpireyDate,
    quoteStatus: quote.Status,
    currencyCode: quote.CurrencyCode,
    lineItems: quote.LineItems,
    subTotal: quote.SubTotal,
    taxTotal: quote.TotalTax,
    quTotal: quote.Total,
    title: quote.Title,
    invNumber: existingQuote.invNumber,
    PoNumber: existingQuote.PoNumber,
    quoteAction: steps[steps.length - 1],
    businessUnitvalueid: existingQuote.businessUnitvalueid,
    businessUnitvalue: existingQuote.businessUnitvalue,
    // Preserve existing task IDs
    clickUpTaskidCrm1: existingQuote.clickUpTaskidCrm1,
    clickUpTaskidCrm2: existingQuote.clickUpTaskidCrm2,
    clickUpTaskidCrm5: existingQuote.clickUpTaskidCrm5,
    clickUpTaskidCrm7: existingQuote.clickUpTaskidCrm7,
    clickUpTaskidCrm9: existingQuote.clickUpTaskidCrm9,
    clickUpTaskidCRM050_Global: existingQuote.clickUpTaskidCRM050_Global,
    clickUpTaskidCRM050_SERVICES: existingQuote.clickUpTaskidCRM050_SERVICES,
    clickUpTaskidCRM051_GLOBAL: existingQuote.clickUpTaskidCRM051_GLOBAL,
    clickUpTaskidCRM051_SERVICES: existingQuote.clickUpTaskidCRM051_SERVICES,
    clickUpTaskidCRM032: existingQuote.clickUpTaskidCRM032,
    clickUpTaskidCRM033: existingQuote.clickUpTaskidCRM033,
    quoteId: existingQuote.quoteId || quote.QuoteID,
    createdAt: existingQuote.createdAt,
  };

  // Sequential replay of every missed step. Each applyQuoteStep call guards on
  // the task IDs stored on `updates`, so replaying an already-applied step is
  // a no-op - this is what makes multi-hop jumps safe, and single-step polls
  // behave exactly as before (a 1-step path is just a 1-element list).
  for (const step of steps) {
    await applyQuoteStep(updates, step);
  }

  await updateQuote(existingQuote.id, updates);
  logger.info(`Quote ${quote.QuoteNumber} processed with steps: ${steps.join(' -> ')}`);
}

/**
 * Applies one step to the quote's ClickUp footprint. Each case is idempotent:
 * it checks whether its artifact already exists (via the task IDs stored on
 * `quote`) before creating anything, so steps can safely be re-run or replayed.
 */
export async function applyQuoteStep(quote: any, step: QuoteStep) {
  switch (step) {
    case 'Created':
      // Create task in CRM 1 only
      if (!quote.clickUpTaskidCrm1) {
        const task = await createClickUpTaskForCRM('CRM1', 'Created', quote);
        if (task) {
          quote.clickUpTaskidCrm1 = task.id;
        }
      }
      break;

    case 'Sent':
      // Create task in CRM 2 if we don't have one yet
      if (!quote.clickUpTaskidCrm2) {
        const taskCrm2 = await createClickUpTaskForCRM('CRM2', 'Sent', quote);
        if (taskCrm2) {
          quote.clickUpTaskidCrm2 = taskCrm2.id;
        }
      }

      // Mark CRM 1 task with the status from buildClickUpPayload
      if (quote.clickUpTaskidCrm1) {
        const { status } = await buildClickUpPayload('Sent', quote, 'CRM1');
        await updateClickUpTaskStatus(quote.clickUpTaskidCrm1, status);
        await addClickUpComment(quote.clickUpTaskidCrm1, 'Quote updated and sent');

        if (quote.clickUpTaskidCrm2) {
          await addClickUpComment(
            quote.clickUpTaskidCrm1,
            `Task moved to CRM-02\nhttps://app.clickup.com/t/${quote.clickUpTaskidCrm2}`
          );
        }

        // Update CRM‑01 description with the link (handled by buildClickUpPayload)
        await updateClickUpTask(quote.clickUpTaskidCrm1, quote, 'Sent', 'CRM1');
      }
      break;

    case 'Revision After Sent':
      // Update existing quote in CRM 2
      if (quote.clickUpTaskidCrm2) {
        const taskid = await updateClickUpTask(quote.clickUpTaskidCrm2, quote, step, 'CRM2');
        if (taskid) {
          await addClickUpComment(taskid, 'Quote Revised');
        }
      }
      break;

    case 'Accepted':
      // Defensive: a quote can reach 'Accepted' via replay without CRM-02 ever
      // existing (e.g. legacy DB row, or a missed 'Sent'). Create it first so
      // the rest of this step has a thread to comment on and link from.
      if (!quote.clickUpTaskidCrm2) {
        logger.warn(
          `Quote ${quote.quoteNumber}: 'Accepted' step reached without a CRM-02 task. Creating one now.`
        );
        const taskCrm2 = await createClickUpTaskForCRM('CRM2', 'Sent', quote);
        if (taskCrm2) {
          quote.clickUpTaskidCrm2 = taskCrm2.id;
        }
      }

      // Update CRM-02 task first (per diagram), but don't close it out yet - we need the
      // job card's id before we can post the "moved to job card" comment on CRM-02.
      if (quote.clickUpTaskidCrm2) {
        await updateClickUpTask(quote.clickUpTaskidCrm2, quote, step, 'CRM2');
      }

      // Create the job card (one of CRM-050/051 x Global/Services) if not already created.
      const branchKey = resolveJobCardBranch(quote);
      const branch = JOB_CARD_BRANCHES[branchKey];

      let jobCardTaskId = quote[branch.dbField];
      if (!jobCardTaskId) {
        const taskJobCard = await createClickUpTaskForCRM(branchKey, 'Accepted', quote);
        if (taskJobCard) {
          jobCardTaskId = taskJobCard.id;
          quote[branch.dbField] = jobCardTaskId;

          // Carry over any PO PDF the user already attached on CRM-02 (per the businessUnit
          // webhook, which is where PO No/PDF are now captured) to the new job card.
          if (quote.clickUpTaskidCrm2) {
            await copyAttachments(quote.clickUpTaskidCrm2, jobCardTaskId);
          }
        }
      }

      // Per Rev 1.3: post a "moved to job card" comment on CRM-02 before closing its thread.
      const crmLabel = branchKey.replace('_', '-'); // e.g. CRM050-GLOBAL, CRM051-SERVICES

      if (quote.clickUpTaskidCrm2 && jobCardTaskId) {
        await addClickUpComment(
          quote.clickUpTaskidCrm2,
          `Task moved to ${crmLabel}\nhttps://app.clickup.com/t/${jobCardTaskId}`
        );
      }
      if (quote.clickUpTaskidCrm2) {
        await updateClickUpTaskStatus(quote.clickUpTaskidCrm2, 'complete');
      }
      break;

    case 'Updated':
      // Update CRM 1 task
      if (quote.clickUpTaskidCrm1) {
        const taskid = await updateClickUpTask(quote.clickUpTaskidCrm1, quote, step, 'CRM1');
        if (taskid) {
          await addClickUpComment(taskid, 'Quote Updated');
        }
      }
      break;

    case 'Declined':
      // Create CRM-33 (cold storage) task, referencing CRM-01 and CRM-02.
      if (!quote.clickUpTaskidCRM033) {
        const taskCrm33 = await createClickUpTaskForCRM('CRM033', 'Declined', quote);
        if (taskCrm33) {
          quote.clickUpTaskidCRM033 = taskCrm33.id;
        }
      }

      // Move the CRM-02 thread over to CRM-33 and mark it complete.
      if (quote.clickUpTaskidCrm2 && quote.clickUpTaskidCRM033) {
        await addClickUpComment(
          quote.clickUpTaskidCrm2,
          `Task moved to CRM-33\nhttps://app.clickup.com/t/${quote.clickUpTaskidCRM033}`
        );
        await updateClickUpTaskStatus(quote.clickUpTaskidCrm2, 'complete');
      }
      break;

    case 'Deleted':
      // Create CRM-32 (job lost) task, referencing CRM-01, CRM-02 and CRM-33.
      if (!quote.clickUpTaskidCRM032) {
        const taskCrm32 = await createClickUpTaskForCRM('CRM032', 'Deleted', quote);
        if (taskCrm32) {
          quote.clickUpTaskidCRM032 = taskCrm32.id;
        }
      }

      // Move the CRM-33 thread over to CRM-32 and mark it complete.
      if (quote.clickUpTaskidCRM033 && quote.clickUpTaskidCRM032) {
        await addClickUpComment(
          quote.clickUpTaskidCRM033,
          `Task moved to CRM-32\nhttps://app.clickup.com/t/${quote.clickUpTaskidCRM032}`
        );
        await updateClickUpTaskStatus(quote.clickUpTaskidCRM033, 'complete');
      }
      break;

    case 'Sent After Declined':
      // Confirmed per Rev 1.2 of the diagram: quote was previously Declined (sitting
      // in CRM-33 cold storage) and has now been sent again. Move the thread back to
      // CRM-02 instead of creating a brand new CRM-02 task, and post the "moved"
      // comment on BOTH sides of the move (CRM-02 says where it came from, CRM-33
      // says where it went), then close out CRM-33 and reopen CRM-02.
      //
      // Guards: both CRM-02 and CRM-33 must already exist. If either is missing
      // (partially-synced legacy row) there's nothing meaningful to move - log it.
      if (!quote.clickUpTaskidCrm2 || !quote.clickUpTaskidCRM033) {
        logger.warn(
          `Quote ${quote.quoteNumber}: 'Sent After Declined' needs CRM-02 and CRM-33, ` +
            `got crm2=${!!quote.clickUpTaskidCrm2} crm33=${!!quote.clickUpTaskidCRM033}. Skipping move.`
        );
        break;
      }

      // updateClickUpTask always sets CRM-02 back to 'to do' for this crm ('Mark
      // CRM-02 Thread as Todo' in the diagram), so no separate status call needed.
      await updateClickUpTask(quote.clickUpTaskidCrm2, quote, step, 'CRM2');

      await addClickUpComment(
        quote.clickUpTaskidCrm2,
        `Task moved from CRM-33\nhttps://app.clickup.com/t/${quote.clickUpTaskidCRM033}`
      );

      await addClickUpComment(
        quote.clickUpTaskidCRM033,
        `Task moved to CRM-02\nhttps://app.clickup.com/t/${quote.clickUpTaskidCrm2}`
      );

      await updateClickUpTaskStatus(quote.clickUpTaskidCRM033, 'complete');
      break;

    case 'Accepted Quote Sent':
      // Quote was already Accepted and is being sent again. Per the diagram this
      // is a dead end - no ClickUp task changes, just sync the DB record (handled
      // automatically by updateQuote() after the replay loop).
      logger.info(
        `Quote ${quote.quoteNumber} re-sent after Accepted - DB synced, no ClickUp changes made.`
      );
      break;
  }
}

async function createClickUpTaskForCRM(crm: string, action: string, quote: any): Promise<any> {
  const { topic, listid, description, status, customFields, comment, due_date, quoteUrl } =
    await buildClickUpPayload(action, quote, crm);

  const task = await createClickUpTask(description, topic, listid, status, customFields, due_date);

  if (!task) {
    logger.error(`Failed to create task for ${quote.quoteNumber} in ${crm}`);
    return null;
  }

  await addClickUpComment(task.id, comment);

  logger.info(`Created task ${task.id} for ${quote.quoteNumber} in ${crm}`);
  return task;
}

export async function updateClickUpTaskStatus(taskId: string, status: string) {
  const url = `https://api.clickup.com/api/v2/task/${taskId}`;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: API_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      status,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    logger.error(`Failed to update ClickUp task ${taskId} status: ${err}`);
    return;
  }

  logger.info(`Updated ClickUp task ${taskId} status to ${status}`);
}

export async function buildClickUpPayload(action: string, quote: any, crm: string = 'CRM1') {
  // Per Rev 1.3: job card Name includes the PO No (Qu No, PO No, Customer, Quote Title).
  // CRM-01/02/33/32 keep the original 3-part name. If there's no PO yet, just drop that
  // segment rather than stuffing a fake "No PO" placeholder into every job card title.
  const topic =
    crm in JOB_CARD_BRANCHES
      ? [quote.quoteNumber, quote.PoNumber || null, quote.customerName, quote.title]
          .filter(Boolean)
          .join(' ,')
      : `${quote.quoteNumber} ,${quote.customerName} ,${quote.title}`;

  const { listid, status, description, customFields, comment, due_date, quoteUrl } =
    await constructClickUpPayload(action, quote, crm);

  return { topic, listid, description, status, customFields, comment, due_date, quoteUrl };
}

async function constructClickUpPayload(
  action: string,
  quote: any,
  crm: string = 'CRM1'
): Promise<{
  listid: string;
  status: string;
  description: string;
  customFields: any[];
  comment: string;
  due_date: number;
  quoteUrl: string;
}> {
  let listid = '';
  let status = '';

  //calculate discount
  const totalDiscount = (quote.lineItems || []).reduce(
    (sum: number, item: any) => sum + (item.DiscountAmount || 0),
    0
  );
  // Build quote items (used by some cases)
  const quoteItemsCrm = (quote.lineItems || [])
    .map((item: any, index: number) => {
      return `Item ${index + 1}:
    - Item Description: ${item.Description}
    - Item Quantity: ${item.Quantity}`;
    })
    .join('\n\n');

  const quoteItemsText = (quote.lineItems || [])
    .map((item: any, index: number) => {
      const taxRate =
        item.LineAmount && item.LineAmount !== 0
          ? ((item.TaxAmount / item.LineAmount) * 100).toFixed(2)
          : '0.00';
      return `Item ${index + 1}:
    - Item Description: ${item.Description}
    - Item Quantity: ${item.Quantity}
    - Item Unit Cost: ${item.UnitAmount}
    - Account Code: ${item.AccountCode || 'N/A'}
    - Line Total: ${item.LineAmount}
    - Tax Rate: ${taxRate}%`;
    })
    .join('\n\n');

  const totalsText = `
Quote Currency: ${quote.currencyCode}
Quote Subtotal: ${quote.subTotal}
Quote Discount: ${totalDiscount.toFixed(2)}
Quote Tax: ${quote.taxTotal}
Quote Total: ${quote.quTotal}
`;

  const viewOrEdit = quote.quoteStatus === 'DRAFT' ? 'edit' : 'view';
  const quoteUrl = `${Xero_Url}${viewOrEdit}/${quote.quoteId}`;

  let description = '';
  let comment = '';
  let due_date = 0;
  let customFields: any[] = [];

  if (crm === 'CRM1') {
    listid = process.env.CRM1_LIST_ID!;
    status = action.toLowerCase() === 'sent' ? 'complete' : 'to do';
    due_date = new Date(quote.quoteIssueDate).getTime() + 2 * 24 * 60 * 60 * 1000;
    // For CRM1, we skip the Business Unit line in the description
    let relatedSection = '';
    if (action === 'Sent' && quote.clickUpTaskidCrm2) {
      relatedSection = `**Related Tasks**\nCRM-02 - https://app.clickup.com/t/${quote.clickUpTaskidCrm2}\n\n`;
    }
    const baseDescription = `${relatedSection}
Description:
Scope of Work - ${quote.title}
Quote Status - DRAFT
Quote Expiry - ${quote.quoteExpireyDate}

Quote Link - ${quoteUrl}

Quote Items:
${quoteItemsText}

${totalsText}
`;
    // Remove any potential extra blank lines
    description = baseDescription.replace(/\n\n\n+/g, '\n\n');

    // Custom fields for CRM1
    customFields = [{ id: CUSTOMER_FIELD_ID, value: quote.customerName }];

    if (action === 'Created') {
      comment = 'Quote Created.';
    }
    if (action.toLowerCase() === 'sent') {
      comment = 'Quote Updated and sent';
    }
  } else if (crm === 'CRM2') {
    due_date = new Date(quote.quoteExpireyDate).getTime();
    listid = process.env.CRM2_LIST_ID!;
    status = 'to do';
    customFields = [
      { id: CUSTOMER_FIELD_ID, value: quote.customerName },
      taskLinkField(CRM01_LINK_FIELD_ID, quote.clickUpTaskidCrm1),
    ].filter(Boolean) as any[];
    description = `
Description:
Scope of Work - ${quote.title}
Quote Status - SENT
Quote Expiry - ${quote.quoteExpireyDate}

Quote Link - ${quoteUrl}

Quote Items:
${quoteItemsText}

${totalsText}
`;
    if (action === 'Sent') {
      comment = '@sales please upload quotation pdf.';
    }
  } else if (crm in JOB_CARD_BRANCHES) {
    // One of: CRM050_GLOBAL, CRM050_SERVICES, CRM051_GLOBAL, CRM051_SERVICES
    listid = JOB_CARD_BRANCHES[crm as JobCardBranchKey].listId;
    status = 'to do';
    customFields = [
      { id: CUSTOMER_FIELD_ID, value: quote.customerName },
      { id: BUSINESS_UNIT_FIELD_ID, value: safeBusinessUnitId(quote) },
      taskLinkField(CRM01_LINK_FIELD_ID, quote.clickUpTaskidCrm1),
      taskLinkField(CRM02_LINK_FIELD_ID, quote.clickUpTaskidCrm2),
    ].filter(Boolean) as any[];
    description = `
Description:
Scope of Work - ${quote.title}
Quote Link - ${quoteUrl}

Quote Items:
${quoteItemsCrm}
`;
  } else if (crm === 'CRM033') {
    // crm-033-999-declined-aka-cold-storage
    due_date = new Date(quote.quoteExpireyDate).getTime();
    listid = CRM033_LIST_ID;
    status = 'to do';
    customFields = [
      { id: CUSTOMER_FIELD_ID, value: quote.customerName },
      { id: BUSINESS_UNIT_FIELD_ID, value: safeBusinessUnitId(quote) },
      taskLinkField(CRM01_LINK_FIELD_ID, quote.clickUpTaskidCrm1),
      taskLinkField(CRM02_LINK_FIELD_ID, quote.clickUpTaskidCrm2),
    ].filter(Boolean) as any[];
    description = `
Description:
Scope of Work - ${quote.title}
Quote Status - DECLINED
Quote Expiry - ${quote.quoteExpireyDate}

Quote Link - ${quoteUrl}

Quote Items:
${quoteItemsText}

${totalsText}
`;
    comment = '@sales contact Customer';
  } else if (crm === 'CRM032') {
    // crm-032-999-quote-lost-job-card-group
    due_date = new Date(quote.quoteExpireyDate).getTime();
    listid = CRM032_LIST_ID;
    status = 'to do';
    customFields = [
      { id: CUSTOMER_FIELD_ID, value: quote.customerName },
      { id: BUSINESS_UNIT_FIELD_ID, value: safeBusinessUnitId(quote) },
      taskLinkField(CRM01_LINK_FIELD_ID, quote.clickUpTaskidCrm1),
      taskLinkField(CRM02_LINK_FIELD_ID, quote.clickUpTaskidCrm2),
      taskLinkField(CRM33_LINK_FIELD_ID, quote.clickUpTaskidCRM033),
    ].filter(Boolean) as any[];
    description = `
Description:
Scope of Work - ${quote.title}
Quote Link - ${quoteUrl}

Quote Items:
${quoteItemsText}

${totalsText}
`;
    comment = 'Job Lost';
  }

  return { listid, status, description, customFields, comment, due_date, quoteUrl };
}

async function updateClickUpTask(taskId: string, quote: any, action: string, crm: string = 'CRM1') {
  const { topic, description, status } = await buildClickUpPayload(action, quote, crm);

  const url = `https://api.clickup.com/api/v2/task/${taskId}`;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: API_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: topic,
      description,
      status: status,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    logger.error(`Failed to update ClickUp task ${taskId}: ${err}`);
    return;
  }

  logger.info(`Updated ClickUp task ${taskId}`);
  return taskId;
}

async function createClickUpTask(
  description: string,
  topic: string,
  listId: string,
  status: string,
  customFields: any[],
  due_date: number
): Promise<ClickUpTaskResponse> {
  const res = await fetch(`https://api.clickup.com/api/v2/list/${listId}/task`, {
    method: 'POST',
    headers: {
      Authorization: API_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: topic,
      description,
      status: status,
      due_date: due_date,
      custom_fields: customFields,
    }),
  });

  if (!res.ok) {
    throw new Error(await res.text());
  }

  return (await res.json()) as ClickUpTaskResponse;
}

function getRelatedTasksSection(quote: any, crm: string): string {
  const taskIds = {
    crm1: quote.clickUpTaskidCrm1,
    crm2: quote.clickUpTaskidCrm2,
    crm032: quote.clickUpTaskidCRM032,
    crm033: quote.clickUpTaskidCRM033,
  };

  const links: string[] = [];

  switch (crm) {
    case 'CRM2':
      if (taskIds.crm1) links.push(`CRM-01 - https://app.clickup.com/t/${taskIds.crm1}`);
      break;
    case 'CRM050_GLOBAL':
    case 'CRM050_SERVICES':
    case 'CRM051_GLOBAL':
    case 'CRM051_SERVICES':
      if (taskIds.crm1) links.push(`CRM-01 - https://app.clickup.com/t/${taskIds.crm1}`);
      if (taskIds.crm2) links.push(`CRM-02 - https://app.clickup.com/t/${taskIds.crm2}`);
      break;
    case 'CRM033':
      if (taskIds.crm1) links.push(`CRM-01 - https://app.clickup.com/t/${taskIds.crm1}`);
      if (taskIds.crm2) links.push(`CRM-02 - https://app.clickup.com/t/${taskIds.crm2}`);
      break;
    case 'CRM032':
      if (taskIds.crm1) links.push(`CRM-01 - https://app.clickup.com/t/${taskIds.crm1}`);
      if (taskIds.crm2) links.push(`CRM-02 - https://app.clickup.com/t/${taskIds.crm2}`);
      if (taskIds.crm033) links.push(`CRM-33 - https://app.clickup.com/t/${taskIds.crm033}`);
      break;
    // CRM1 and CRM9 remain unchanged (no links needed)
  }

  if (links.length === 0) return '';

  return `**Related Tasks**\n${links.join('\n')}\n\n`;
}

export async function addClickUpComment(taskId: string, commentText: string) {
  if (!commentText) return;
  const res = await fetch(`https://api.clickup.com/api/v2/task/${taskId}/comment`, {
    method: 'POST',
    headers: {
      Authorization: API_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ comment_text: commentText }),
  });
  if (!res.ok) console.error('Comment failed:', await res.text());
}

// Copies every attachment on sourceTaskId over to targetTaskId, skipping any whose URL is
// already present on the target (so this is safe to call more than once for the same pair).
export async function copyAttachments(sourceTaskId: string, targetTaskId: string): Promise<number> {
  const sourceTask = await getClickUpTask(sourceTaskId);
  if (!sourceTask.attachments || !sourceTask.attachments.length) return 0;

  const targetTask = await getClickUpTask(targetTaskId);
  const existingUrls = new Set((targetTask.attachments || []).map((att: any) => att.url));

  let copied = 0;
  for (const file of sourceTask.attachments) {
    if (!existingUrls.has(file.url)) {
      await uploadAttachmentToClickUpTask(targetTaskId, file.url);
      copied++;
    }
  }
  return copied;
}

export async function uploadAttachmentToClickUpTask(taskId: string, fileUrl: string) {
  if (!API_TOKEN) throw new Error('ClickUp token not set');

  const fileResponse = await fetch(fileUrl);
  if (!fileResponse.ok) {
    throw new Error(`Failed to download file from ${fileUrl}: ${fileResponse.statusText}`);
  }

  const arrayBuffer = await fileResponse.arrayBuffer(); // No deprecation
  const buffer = Buffer.from(arrayBuffer);

  const filename = decodeURIComponent(fileUrl.split('/').pop() || 'attachment');

  const formData = new FormData();
  formData.append('attachment', buffer, filename);

  const response = await fetch(`https://api.clickup.com/api/v2/task/${taskId}/attachment`, {
    method: 'POST',
    headers: {
      Authorization: API_TOKEN,
      // Let fetch set Content-Type automatically
    },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to upload attachment: ${response.status} ${errorText}`);
  }

  return await response.json();
}

// Extract Quote Name (quote number) from task
export function extractQuoteName(task: any): string | null {
  if (!task.name) return null;

  // Take the first part before the first comma
  const quoteName = task.name.split(',')[0].trim();
  return quoteName || null;
}

export async function updateClickUpTaskCrm9(taskId: string, description: string) {
  const url = `https://api.clickup.com/api/v2/task/${taskId}`;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: API_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      description,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    logger.error(`Failed to update ClickUp task ${taskId}: ${err}`);
    return;
  }

  logger.info(`Updated ClickUp task ${taskId}`);
  return taskId;
}
