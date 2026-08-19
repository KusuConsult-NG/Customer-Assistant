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

export interface EnrolleeCardData {
  policyId: string;
  fullName: string;
  phoneNumber: string;
  residentialAddress?: string;
  ageOrDob?: string;
  planType: string;
  lga: string;
  preferredHospital: string;
  nin?: string;
  photoUrl?: string;
  dependents?: Array<{ fullName: string; relationship: string }>;
  issuedAt: string;
  expiresAt: string;
  organizationName?: string;
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

  /**
   * Generates a digital PLASCHEMA enrollee ID card and certificate of coverage.
   */
  static generateEnrolleeDigitalCard(data: EnrolleeCardData): { html: string; summaryText: string } {
    const orgName = data.organizationName || 'PLASCHEMA';

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8" />
      <title>PLASCHEMA Digital ID - ${data.policyId}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #0f172a; color: #f8fafc; padding: 24px; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
        .card-container { width: 100%; max-width: 480px; background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); border-radius: 24px; border: 2px solid #74BA03; padding: 24px; box-shadow: 0 20px 40px rgba(0,0,0,0.4); position: relative; overflow: hidden; }
        .card-glow { position: absolute; top: -50px; right: -50px; width: 180px; height: 180px; background: #74BA03; filter: blur(80px); opacity: 0.25; border-radius: 50%; pointer-events: none; }
        .card-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; border-bottom: 1px solid rgba(116, 186, 3, 0.3); padding-bottom: 16px; }
        .agency-title { font-size: 16px; font-weight: 800; color: #74BA03; letter-spacing: 0.5px; }
        .agency-sub { font-size: 10px; color: #94a3b8; margin-top: 2px; text-transform: uppercase; letter-spacing: 1px; }
        .badge { background: #74BA03; color: #0f172a; font-size: 10px; font-weight: 800; padding: 4px 10px; border-radius: 20px; text-transform: uppercase; }
        .card-body { display: flex; gap: 18px; margin-bottom: 20px; }
        .photo-frame { width: 90px; height: 115px; border-radius: 14px; background: #334155; border: 2px solid #74BA03; overflow: hidden; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
        .photo-frame img { width: 100%; height: 100%; object-fit: cover; }
        .photo-placeholder { font-size: 32px; color: #64748b; }
        .enrollee-meta { flex: 1; display: flex; flex-direction: column; justify-content: space-between; }
        .name { font-size: 16px; font-weight: 700; color: #ffffff; line-height: 1.2; margin-bottom: 6px; }
        .policy-id { font-size: 12px; font-family: monospace; font-weight: bold; color: #74BA03; margin-bottom: 8px; }
        .info-row { font-size: 11px; color: #cbd5e1; margin-bottom: 4px; }
        .info-label { color: #64748b; font-size: 9px; text-transform: uppercase; display: block; font-weight: 600; }
        .facility-box { background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 14px; padding: 12px 14px; margin-bottom: 16px; font-size: 11px; }
        .facility-title { font-size: 9px; text-transform: uppercase; color: #74BA03; font-weight: 700; margin-bottom: 2px; }
        .facility-name { color: #f1f5f9; font-weight: 600; }
        .card-footer { display: flex; justify-content: space-between; align-items: center; border-top: 1px solid rgba(255, 255, 255, 0.1); padding-top: 14px; font-size: 10px; color: #64748b; }
        .helpline { color: #74BA03; font-weight: 700; }
      </style>
    </head>
    <body>
      <div class="card-container">
        <div class="card-glow"></div>
        <div class="card-header">
          <div>
            <div class="agency-title">${orgName}</div>
            <div class="agency-sub">Plateau State Contributory Healthcare</div>
          </div>
          <div class="badge">ACTIVE BENEFICIARY</div>
        </div>

        <div class="card-body">
          <div class="photo-frame">
            ${data.photoUrl ? `<img src="${data.photoUrl}" alt="Enrollee Photo" />` : `<span class="photo-placeholder">👤</span>`}
          </div>
          <div class="enrollee-meta">
            <div>
              <div class="name">${data.fullName}</div>
              <div class="policy-id">ID: ${data.policyId}</div>
            </div>
            <div>
              <div class="info-row">
                <span class="info-label">Plan Type</span>
                ${data.planType} ${data.ageOrDob ? `• Age: ${data.ageOrDob}` : ''}
              </div>
              <div class="info-row">
                <span class="info-label">Address & LGA</span>
                ${data.residentialAddress ? `${data.residentialAddress}, ` : ''}${data.lga} ${data.nin ? `• NIN: ${data.nin.slice(0, 4)}***` : ''}
              </div>
            </div>
          </div>
        </div>

        ${
          data.dependents && data.dependents.length > 0
            ? `
        <div style="background: rgba(116, 186, 3, 0.08); border: 1px dashed rgba(116, 186, 3, 0.3); border-radius: 14px; padding: 10px 14px; margin-bottom: 16px; font-size: 11px;">
          <div style="font-size: 9px; text-transform: uppercase; color: #74BA03; font-weight: 700; margin-bottom: 4px;">Covered Family Dependents (${data.dependents.length})</div>
          <div style="color: #e2e8f0; font-size: 10px; line-height: 1.4;">
            ${data.dependents.map((d) => `• <strong>${d.fullName}</strong> (${d.relationship})`).join('<br/>')}
          </div>
        </div>
        `
            : ''
        }

        <div class="facility-box">
          <div class="facility-title">Primary Healthcare Provider (PHCP)</div>
          <div class="facility-name">${data.preferredHospital}</div>
        </div>

        <div class="card-footer">
          <div>Issued: ${data.issuedAt}</div>
          <div>24/7 Helpline: <span class="helpline">0700-700-1111</span></div>
        </div>
      </div>
    </body>
    </html>
    `;

    const summaryText = `🏥 *${orgName} Digital Healthcare ID*\nEnrollee: ${data.fullName}\nPolicy ID: ${data.policyId}\nPlan: ${data.planType}\nPrimary Facility: ${data.preferredHospital}\nLGA: ${data.lga}\nStatus: ACTIVE`;

    return { html, summaryText };
  }
}

