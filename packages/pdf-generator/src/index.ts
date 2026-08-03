export interface QuotationItem {
  description: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
}

export interface QuotationData {
  quotationNumber: string;
  organizationName: string;
  organizationPhone: string;
  customerName: string;
  customerPhone: string;
  items: QuotationItem[];
  subtotal: number;
  tax: number;
  grandTotal: number;
  currency: string;
  validUntil: string;
}

export class PdfGeneratorService {
  /**
   * Generates a styled HTML/PDF Document string suitable for converting into PDF
   * or serving as a formatted quotation/invoice download link.
   */
  static generateQuotationDocument(data: QuotationData): { html: string; summaryText: string; documentUrl: string } {
    const currencySymbol = data.currency === 'NGN' ? '₦' : '$';

    const itemsHtml = data.items
      .map(
        (item) => `
        <tr style="border-bottom: 1px solid #e5e7eb;">
          <td style="padding: 10px; font-size: 12px; color: #374151;">${item.description}</td>
          <td style="padding: 10px; font-size: 12px; color: #374151; text-align: center;">${item.quantity}</td>
          <td style="padding: 10px; font-size: 12px; color: #374151; text-align: right;">${currencySymbol}${item.unitPrice.toLocaleString()}</td>
          <td style="padding: 10px; font-size: 12px; font-weight: bold; color: #111827; text-align: right;">${currencySymbol}${item.totalPrice.toLocaleString()}</td>
        </tr>`
      )
      .join('');

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8" />
      <title>Quotation ${data.quotationNumber}</title>
      <style>
        body { font-family: 'Helvetica Neue', Arial, sans-serif; background: #f9fafb; margin: 0; padding: 20px; }
        .container { max-width: 600px; margin: 0 auto; background: #ffffff; padding: 30px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.05); }
        .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #0284c7; padding-bottom: 15px; margin-bottom: 20px; }
        .title { font-size: 20px; font-weight: bold; color: #0284c7; }
        .details { font-size: 12px; color: #6b7280; margin-bottom: 20px; line-height: 1.5; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
        th { background: #f3f4f6; color: #4b5563; font-size: 11px; text-transform: uppercase; padding: 10px; text-align: left; }
        .total-box { font-size: 14px; font-weight: bold; text-align: right; color: #0284c7; padding-top: 10px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div class="title">${data.organizationName}</div>
          <div style="font-size: 12px; font-weight: bold; color: #374151;">QUOTATION #${data.quotationNumber}</div>
        </div>
        <div class="details">
          <strong>Prepared For:</strong> ${data.customerName} (${data.customerPhone})<br />
          <strong>Date:</strong> ${new Date().toLocaleDateString('en-NG')}<br />
          <strong>Valid Until:</strong> ${data.validUntil}
        </div>
        <table>
          <thead>
            <tr>
              <th>Description</th>
              <th style="text-align: center;">Qty</th>
              <th style="text-align: right;">Unit Price</th>
              <th style="text-align: right;">Total</th>
            </tr>
          </thead>
          <tbody>
            ${itemsHtml}
          </tbody>
        </table>
        <div class="total-box">
          GRAND TOTAL: ${currencySymbol}${data.grandTotal.toLocaleString()}
        </div>
      </div>
    </body>
    </html>
    `;

    const summaryText = `📄 *Official Quotation #${data.quotationNumber}*\nOrganization: ${data.organizationName}\nTotal Amount: ${currencySymbol}${data.grandTotal.toLocaleString()}\nValid Until: ${data.validUntil}`;

    const documentUrl = `/api/documents/quotation/${data.quotationNumber}.pdf`;

    return { html, summaryText, documentUrl };
  }
}
