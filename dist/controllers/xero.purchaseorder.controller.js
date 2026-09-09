import logger from "../utils/logger.js";
import { getClickUpTask } from "../services/clickUpfetch.service.js";
import { getQuoteByNumber, updateQuote } from "../repositories/dynamo.quote.repository.js";
import { extractQuoteName, updateClickUpTaskStatus, uploadAttachmentToClickUpTask, getJobCardTaskId, } from "../services/xero.quote.service.js";
import { getInvByXeroInvoiceNumber, updateInvoice } from "../repositories/xero.invoice.repository.js";
export const BUSINESS_UNIT_FIELD_ID = "fdf29394-d070-4384-863c-9f2f5885061f";
export const PURCHASE_ORDER_NUMBER_FIELD_ID = "7830276e-f1bb-4efc-8e87-e34693cbd712";
const CUSTOMER_FIELD_ID = "b1b8b307-162d-46b6-8dbb-6e995d1130bc";
const CRM07_LINK_FIELD_ID = "30dfc6ea-3e9b-4bf3-962d-1586cd4482d2";
const API_TOKEN = process.env.CLICKUP_API_TOKEN;
export const xeroPOController = {
    poUpdate: async (req, res) => {
        try {
            const taskId = parseInspectionClickUpPayload(req.body);
            // Fetch the full ClickUp task (CRM2)
            const task = await getClickUpTask(taskId);
            // Extract Purchase Order Number from custom fields
            const poNumber = extractPurchaseOrderNumber(task);
            // Extract Quote Name from text_content or description
            const quoteName = extractQuoteName(task);
            if (!quoteName) {
                return res.status(400).json({
                    success: false,
                    error: "Quote number not found in task description",
                });
            }
            // Fetch quote from DB
            const existingQuote = await getQuoteByNumber(quoteName);
            if (!existingQuote) {
                return res.status(404).json({
                    success: false,
                    error: "Quote not found",
                });
            }
            // Build updates object
            const updates = {
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
                invNumber: existingQuote.invNumber,
                PoNumber: poNumber || existingQuote.PoNumber || null,
                clickUpTaskidCrm1: existingQuote.clickUpTaskidCrm1,
                clickUpTaskidCrm2: existingQuote.clickUpTaskidCrm2,
                clickUpTaskidCrm5: existingQuote.clickUpTaskidCrm5,
                clickUpTaskidCrm7: existingQuote.clickUpTaskidCrm7,
                clickUpTaskidCrm9: existingQuote.clickUpTaskidCrm9,
                quoteId: existingQuote.quoteId,
                createdAt: existingQuote.createdAt,
            };
            // Update quote in DB
            await updateQuote(existingQuote.id, updates);
            // Check attachments exist on CRM2 task
            if (!task.attachments || !task.attachments.length) {
                return res.status(400).json({
                    success: false,
                    error: "No PO attachments found in the source task",
                });
            }
            // Copy PO files to whichever job card (CRM-050/051 x Global/Services) this quote
            // actually has - clickUpTaskidCrm5/Crm7 are the old, now-unused single job-card list
            // and are never populated for quotes going through the current 4-way split.
            const jobCardTaskId = getJobCardTaskId(existingQuote);
            if (jobCardTaskId) {
                const targetTask = await getClickUpTask(jobCardTaskId);
                const existingUrls = new Set((targetTask.attachments || []).map((att) => att.url));
                for (const file of task.attachments) {
                    if (!existingUrls.has(file.url)) {
                        await uploadAttachmentToClickUpTask(jobCardTaskId, file.url);
                    }
                }
            }
            else {
                // Quote hasn't been Accepted yet (no job card exists) - the businessUnit webhook's
                // copy-on-Accept step (see xero.quote.service.ts) will carry these attachments over
                // once the job card is created, so this isn't an error, just a no-op for now.
                logger.info(`poUpdate: no job card exists yet for quote ${quoteName} - skipping attachment copy`);
            }
            // Mark CRM2 as complete
            await updateClickUpTaskStatus(taskId, "complete");
            return res.status(200).json({
                success: true,
                poNumber,
                quoteName,
            });
        }
        catch (error) {
            console.error("Error updating Purchase Order Number:", error);
            return res.status(500).json({
                success: false,
                error: error.message || "Unknown error",
            });
        }
    },
    poDUpdate: async (req, res) => {
        try {
            const taskId = parseInspectionClickUpPayload(req.body);
            // Fetch the target ClickUp task (where POD should be attached)
            const targetTask = await getClickUpTask(taskId);
            // Extract Quote Name from task description or text_content
            const quoteName = extractQuoteName(targetTask);
            if (!quoteName) {
                return res.status(400).json({
                    success: false,
                    error: "Quote number not found in task description",
                });
            }
            // Pull the existing quote from the database
            const existingQuote = await getQuoteByNumber(quoteName);
            if (!existingQuote) {
                return res.status(404).json({
                    success: false,
                    error: "Quote not found in the database",
                });
            }
            // Fetch the source task where POD is currently attached
            const sourceTaskId = existingQuote.clickUpTaskidCrm5;
            const sourceTask = await getClickUpTask(sourceTaskId);
            if (!sourceTask.attachments || !sourceTask.attachments.length) {
                return res.status(400).json({
                    success: false,
                    error: "No POD attachments found in the source task",
                });
            }
            const targetTaskId = existingQuote.clickUpTaskidCrm7;
            // Fetch the target task (CRM7) to see which attachments already exist
            const targetTaskDetails = await getClickUpTask(targetTaskId);
            const existingUrls = new Set((targetTaskDetails.attachments || []).map((att) => att.url));
            let uploaded = 0;
            for (const file of sourceTask.attachments) {
                // Only upload if the file's URL is not already in the target task
                if (!existingUrls.has(file.url)) {
                    await uploadAttachmentToClickUpTask(targetTaskId, file.url);
                    uploaded++;
                }
            }
            return res.status(200).json({
                success: true,
                message: `${uploaded} new POD attachment(s) copied to task ${targetTaskId}`,
                skipped: sourceTask.attachments.length - uploaded,
            });
        }
        catch (error) {
            console.error("Error updating POD attachments:", error);
            return res.status(500).json({
                success: false,
                error: error.message || "Unknown error",
            });
        }
    },
    invUpdate: async (req, res) => {
        try {
            console.log("INV route triggered");
            const taskId = parseInspectionClickUpPayload(req.body);
            const targetTask = await getClickUpTask(taskId);
            const quoteName = extractQuoteName(targetTask);
            if (!quoteName) {
                return res.status(400).json({ success: false, error: "Quote number not found" });
            }
            const existingQuote = await getQuoteByNumber(quoteName);
            if (!existingQuote) {
                return res.status(404).json({ success: false, error: "Quote not found" });
            }
            // 1. Read invoice number from main task
            const invoiceNumberField = targetTask.custom_fields.find((field) => field.name === "Invoice Number");
            const invoiceNumber = invoiceNumberField?.value?.trim() || null;
            //  Idempotency check — if field is already cleared, this is a re-trigger, bail out silently
            if (!invoiceNumber) {
                logger.info(`Skipping invUpdate for task ${taskId} — Invoice Number field is empty (already processed)`);
                return res.status(200).json({ success: true, message: "Already processed, skipping" });
            }
            // 2. Validate invoice in Xero
            const targetInvoice = await getInvByXeroInvoiceNumber(invoiceNumber);
            if (!targetInvoice) {
                return res.status(404).json({ success: false, error: "Invoice not found in Xero" });
            }
            // 3. Check if subtask already exists
            const existingSubtasks = targetTask.subtasks || [];
            const duplicate = existingSubtasks.find((st) => st.name.includes(invoiceNumber));
            if (duplicate) {
                return res.status(200).json({ success: true, message: "Already processed, skipping" });
            }
            // 4. Create subtask under main task for this invoice
            const subtask = await createInvoiceSubtask(targetTask, invoiceNumber);
            // 5. Create CRM9 task for this invoice
            const crm9Task = await createCrm9Task(targetInvoice, existingQuote, invoiceNumber);
            // 6. Update invoice with quote + CRM9 task ID
            await updateInvoiceFromQuote(targetInvoice, existingQuote, crm9Task.id);
            // 7. Clear main task invoice field after success
            const invoiceFieldId = invoiceNumberField.id;
            await clearInvoiceNumberField(targetTask.id, invoiceFieldId);
            return res.status(200).json({ success: true, message: "Invoice processed successfully" });
        }
        catch (error) {
            logger.error("Error in invUpdate:", error);
            return res.status(200).json({
                success: false,
                error: error.message || "Unknown error",
            });
        }
    },
};
//1. Parse task ID from webhook payload
function parseInspectionClickUpPayload(clickupPayload) {
    try {
        return clickupPayload.payload.id;
    }
    catch (error) {
        logger.error("Error parsing inspection payload:", error);
        throw error;
    }
}
//2. Extract Purchase Order Number from custom fields
export function extractPurchaseOrderNumber(task) {
    const t = task.task || task;
    const customFields = t.custom_fields || [];
    const poField = customFields.find((field) => field.id === PURCHASE_ORDER_NUMBER_FIELD_ID || field.name === "Purchase Order Number");
    if (poField && poField.value) {
        return poField.value.toString().trim();
    }
    return null;
}
//3. create task in crm9
async function createClickUpTask(description, topic, listId, status, customFields) {
    const res = await fetch(`https://api.clickup.com/api/v2/list/${listId}/task`, {
        method: "POST",
        headers: {
            Authorization: API_TOKEN,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            name: topic,
            description,
            status: status,
            custom_fields: customFields,
        }),
    });
    if (!res.ok) {
        throw new Error(await res.text());
    }
    return (await res.json());
}
//4. Helper function to create the CRM9 ClickUp task
async function createCrm9Task(invoice, quote, invoiceNumber) {
    const linktoCrm07 = `https://app.clickup.com/t/${quote.clickUpTaskidCrm7}`;
    const topic = `${invoiceNumber} ,${quote.quoteNumber} ,${invoice.customerName}`;
    const listid = process.env.CRM9_LIST_ID;
    const status = "to do";
    const customFields = [
        { id: CUSTOMER_FIELD_ID, value: invoice.customerName },
        { id: BUSINESS_UNIT_FIELD_ID, value: quote.businessUnitvalueid },
        { id: CRM07_LINK_FIELD_ID, value: linktoCrm07 },
    ];
    const description = `
    Description:
    Invoice Date Sent - ${invoice.invoiceDate}
    Invoice Amount - ${invoice.amountDue}
    Due Date - ${invoice.dueDate}
  `;
    const task = await createClickUpTask(description, topic, listid, status, customFields);
    if (!task) {
        logger.error(`Failed to create task for ${invoiceNumber} in CRM09`);
        throw new Error("Failed to create ClickUp task");
    }
    return task;
}
//5. Helper function to update the invoice with fields from the quote and the new task ID
async function updateInvoiceFromQuote(invoice, quote, newTaskId) {
    // Build updates object without updatedAt (let updateInvoice handle it)
    const updates = {
        invoiceNumber: invoice.invoiceNumber,
        reference: quote.quoteReference || invoice.reference,
        customerID: invoice.customerID,
        customerName: invoice.customerName,
        invoiceDate: invoice.invoiceDate,
        dueDate: invoice.dueDate,
        status: invoice.status,
        currencyCode: invoice.currencyCode,
        lineItems: invoice.lineItems || quote.lineItems,
        subTotal: invoice.subTotal,
        taxTotal: invoice.taxTotal,
        total: invoice.total,
        amountPaid: invoice.amountPaid,
        amountDue: invoice.amountDue,
        PoNumber: quote.PoNumber || invoice.PoNumber,
        invoiceAction: invoice.invoiceAction,
        // Fields from quote
        businessUnitvalueid: quote.businessUnitvalueid,
        businessUnitvalue: quote.businessUnitvalue,
        clickUpTaskidCrm1: quote.clickUpTaskidCrm1,
        clickUpTaskidCrm2: quote.clickUpTaskidCrm2,
        clickUpTaskidCrm5: quote.clickUpTaskidCrm5,
        clickUpTaskidCrm7: quote.clickUpTaskidCrm7,
        clickUpTaskidCrm9: newTaskId,
        quoteNumber: quote.quoteNumber,
        xeroQuoteId: invoice.xeroQuoteId,
        createdAt: invoice.createdAt, // keep as-is
    };
    await updateInvoice(invoice.id, updates);
    logger.info("\u2705 Invoice updated with quote fields:");
}
// 6. Create subtask under main task for this invoice
async function createInvoiceSubtask(parentTask, invoiceNumber) {
    const res = await fetch(`https://api.clickup.com/api/v2/list/${parentTask.list.id}/task`, {
        method: "POST",
        headers: {
            Authorization: API_TOKEN,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            name: `Invoice: ${invoiceNumber}`,
            description: parentTask.description || `Subtask for invoice ${invoiceNumber}`,
            parent: parentTask.id,
            status: parentTask.status?.status || "to do",
            priority: parentTask.priority?.id || null,
            due_date: parentTask.due_date || null,
            due_date_time: parentTask.due_date_time || false,
            assignees: parentTask.assignees?.map((a) => a.id) || [],
            tags: parentTask.tags?.map((t) => t.name) || [],
            custom_fields: parentTask.custom_fields
                ?.filter((f) => f.value !== null && f.value !== undefined && f.value !== "")
                .map((f) => ({
                id: f.id,
                value: f.value,
            })) || [],
        }),
    });
    if (!res.ok) {
        const err = await res.text();
        logger.error(`Failed to create subtask for invoice ${invoiceNumber}: ${err}`);
        throw new Error("Failed to create invoice subtask");
    }
    const task = await res.json();
    logger.info(`Created subtask ${task.id} for invoice ${invoiceNumber}`);
    return task;
}
// 7. Clear the Invoice Number field on the main task
async function clearInvoiceNumberField(taskId, fieldId) {
    const res = await fetch(`https://api.clickup.com/api/v2/task/${taskId}/field/${fieldId}`, {
        method: "DELETE",
        headers: {
            Authorization: API_TOKEN,
            "Content-Type": "application/json",
        },
    });
    if (!res.ok) {
        const err = await res.text();
        logger.error(`Failed to clear invoice number field on task ${taskId}: ${err}`);
        throw new Error("Failed to clear main task invoice field");
    }
    logger.info(`Cleared Invoice Number field on task ${taskId}`);
}
