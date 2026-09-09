import { Request, Response } from 'express';
import { getClickUpTask, updateClickUpBusinessUnit } from '../services/clickUpfetch.service';
import { getQuoteByNumber, updateQuote } from '../repositories/dynamo.quote.repository';
import { extractQuoteName, addClickUpComment } from '../services/xero.quote.service';
import { extractPurchaseOrderNumber } from './xero.purchaseorder.controller';

export const businessUnit_FIELD_ID = 'fdf29394-d070-4384-863c-9f2f5885061f';
// Allowed Business Unit option IDs from ClickUp
const ALLOWED_BUSINESS_UNIT_IDS = [
  'a6ce6bb6-123f-4c9d-b964-dfdb6d4e95ad', // Services
  'f0dec408-0e75-4248-aed4-282b2ca74fce', // Global
];
const DEFAULT_BUSINESS_UNIT_ID = 'a6ce6bb6-123f-4c9d-b964-dfdb6d4e95ad'; // Services

export const xeroBusinessUnitController = {
  businessUnit: async (req: Request, res: Response) => {
    try {
      const taskId = parseInspectionClickUpPayload(req.body);

      // Fetch the full ClickUp task
      const task = await getClickUpTask(taskId);

      // Extract Business Unit info
      const businessUnit = extractBusinessUnit(task);

      // Update ClickUp Business Unit
      if (businessUnit) {
        await updateClickUpBusinessUnit(taskId, businessUnit.valueId);
      }

      // Per Rev 1.3: PO No is now captured on this same task/webhook, alongside Business
      // Unit, before the job card is ever created - fixes job card branch selection
      // (PO = #INTPO?) running against an empty PoNumber.
      const poNumber = extractPurchaseOrderNumber(task);

      // Extract Quote Name from text_content or description
      const quoteName = extractQuoteName(task) as string;

      // console.log(JSON.stringify(req.body));

      // Fetch quote from DB
      const existingQuote = await getQuoteByNumber(quoteName);

      if (!existingQuote) {
        return res.status(404).json({
          success: false,
          error: 'Quote not found',
        });
      }

      // Build updates object using the actual fields from existingQuote
      const updates: any = {
        quoteNumber: existingQuote.quoteNumber,
        quoteReference: existingQuote.quoteReference,
        customerID: existingQuote.customerID,
        customerName: existingQuote.customerName,
        quoteIssueDate: existingQuote.quoteIssueDate,
        quoteExpireyDate: existingQuote.quoteExpireyDate,
        quoteStatus: existingQuote.quoteStatus,
        currencyCode: existingQuote.currencyCode,
        lineItems: existingQuote.lineItems,
        subTotal: existingQuote.subTotal,
        taxTotal: existingQuote.taxTotal,
        quTotal: existingQuote.quTotal,
        quoteAction: existingQuote.quoteAction,
        title: existingQuote.title,
        // Set business unit fields from extracted data
        businessUnitvalueid: businessUnit?.valueId || existingQuote.businessUnitvalueid,
        businessUnitvalue: businessUnit?.name || existingQuote.businessUnitvalue,
        // PO No captured here now too (see comment above)
        PoNumber: poNumber || existingQuote.PoNumber || '',
        // Preserve ClickUp task IDs
        clickUpTaskidCrm1: existingQuote.clickUpTaskidCrm1,
        clickUpTaskidCrm2: existingQuote.clickUpTaskidCrm2,
        clickUpTaskidCrm5: existingQuote.clickUpTaskidCrm5,
        clickUpTaskidCrm7: existingQuote.clickUpTaskidCrm7,
        clickUpTaskidCrm9: existingQuote.clickUpTaskidCrm9,
        quoteId: existingQuote.quoteId,
        createdAt: existingQuote.createdAt,
      };

      const quoteUpdate = await updateQuote(existingQuote.id, updates);

      // Per Rev 1.3: confirm both allocations back on the task as comments.
      if (poNumber) {
        await addClickUpComment(taskId, `Purchase order : ${poNumber} Allocated`);
      }
      if (businessUnit) {
        await addClickUpComment(taskId, `Business Unit : ${businessUnit.name} Allocated`);
      }

      return res.status(200).json({
        success: true,
        businessUnit,
        poNumber,
        quoteName,
      });
    } catch (error: any) {
      console.error('Error updating Business Unit:', error);
      return res.status(500).json({
        success: false,
        error: error.message || 'Unknown error',
      });
    }
  },
};

// Parse task ID from webhook payload
function parseInspectionClickUpPayload(clickupPayload: any): string {
  return clickupPayload?.payload?.id || clickupPayload?.id;
}

// Extract Business Unit with TypeScript-safe types
function extractBusinessUnit(task: any) {
  const t = task.task || task;

  type Option = { id: string; name: string; orderindex?: number };
  type CustomField = {
    id: string;
    name: string;
    value?: string | number;
    type_config?: { options: Option[] };
  };

  const field = t.custom_fields?.find((f: CustomField) => f.name === 'Business Unit');
  if (!field) return null;

  const options = field.type_config?.options || [];
  if (options.length === 0) return null;

  // Find the option currently selected in ClickUp
  let selectedOption = options.find(
    (opt: Option) => opt.id === field.value || opt.orderindex === field.value
  );

  // If nothing selected, use default (Services)
  if (!selectedOption) {
    const defaultOption = options.find((opt: Option) => opt.id === DEFAULT_BUSINESS_UNIT_ID);
    return defaultOption
      ? { valueId: defaultOption.id, name: defaultOption.name, rawValue: defaultOption.id }
      : null;
  }

  // If selected is not in the allowed list, override with default (Services)
  if (!ALLOWED_BUSINESS_UNIT_IDS.includes(selectedOption.id)) {
    const defaultOption = options.find((opt: Option) => opt.id === DEFAULT_BUSINESS_UNIT_ID);
    if (defaultOption) {
      return {
        valueId: defaultOption.id,
        name: defaultOption.name,
        rawValue: defaultOption.id,
      };
    }
    // Fallback: keep the selected (shouldn't happen if default exists)
  }

  // Valid selection (Services or Global)
  return {
    valueId: selectedOption.id,
    name: selectedOption.name,
    rawValue: field.value,
  };
}
