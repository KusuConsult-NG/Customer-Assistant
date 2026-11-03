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
  /** Omitted rather than guessed: an unknown value must not be printed. */
  planType?: string;
  lga?: string;
  preferredHospital?: string;
  /** The agency's own published number. No default — see the footer. */
  helpline?: string;
  nin?: string;
  photoUrl?: string;
  dependents?: Array<{ fullName: string; relationship: string }>;
  issuedAt: string;
  expiresAt: string;
  organizationName?: string;
}

/**
 * The card is citizen-facing output, so its colours are the same ramp the
 * dashboard uses — apps/web/tailwind.config.js. They are repeated here rather
 * than imported because this package must not depend on the web app, and
 * apps/api/test/palette-contrast.spec.ts fails if the two ever disagree.
 *
 * The card is dark in both themes, so the text role is the mark colour itself
 * (7.18:1 on the card) rather than the 700 step the light dashboard needs.
 */
const BRAND = {
  mark: '#74ba03',   // brand-500
  fill: '#4d7d02',   // brand-600
  deep: '#3b6102',   // brand-700
} as const;

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
   * Generates a digital identity card for a citizen registered with an agency.
   *
   * Every word on it that names an agency comes from `data.organizationName`.
   * It used to fall back to one scheme's name and title itself "PLASCHEMA
   * Digital ID", so a card issued by any other agency carried the wrong body's
   * name — on the one artefact a citizen is most likely to present as proof.
   */
  static generateEnrolleeDigitalCard(data: EnrolleeCardData): { html: string; summaryText: string } {
    // No fallback to a scheme. A card is presented as proof of who registered
    // the holder; the wrong agency's name on it is worse than none.
    const orgName = data.organizationName || '';

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8" />
      <title>Digital ID - ${data.policyId}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #0f172a; color: #f8fafc; padding: 24px; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
        .card-container { width: 100%; max-width: 480px; background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); border-radius: 24px; border: 2px solid ${BRAND.mark}; padding: 24px; box-shadow: 0 20px 40px rgba(0,0,0,0.4); position: relative; overflow: hidden; }
        .card-glow { position: absolute; top: -50px; right: -50px; width: 180px; height: 180px; background: ${BRAND.mark}; filter: blur(80px); opacity: 0.25; border-radius: 50%; pointer-events: none; }
        .card-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; border-bottom: 1px solid rgba(116, 186, 3, 0.3); padding-bottom: 16px; }
        .agency-title { font-size: 16px; font-weight: 800; color: ${BRAND.mark}; letter-spacing: 0.5px; }
        .agency-sub { font-size: 10px; color: #94a3b8; margin-top: 2px; text-transform: uppercase; letter-spacing: 1px; }
        .badge { background: ${BRAND.mark}; color: #0f172a; font-size: 10px; font-weight: 800; padding: 4px 10px; border-radius: 20px; text-transform: uppercase; }
        .card-body { display: flex; gap: 18px; margin-bottom: 20px; }
        .photo-frame { width: 90px; height: 115px; border-radius: 14px; background: #334155; border: 2px solid ${BRAND.mark}; overflow: hidden; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
        .photo-frame img { width: 100%; height: 100%; object-fit: cover; }
        .photo-placeholder { font-size: 32px; color: #64748b; }
        .enrollee-meta { flex: 1; display: flex; flex-direction: column; justify-content: space-between; }
        .name { font-size: 16px; font-weight: 700; color: #ffffff; line-height: 1.2; margin-bottom: 6px; }
        .policy-id { font-size: 12px; font-family: monospace; font-weight: bold; color: ${BRAND.mark}; margin-bottom: 8px; }
        .info-row { font-size: 11px; color: #cbd5e1; margin-bottom: 4px; }
        .info-label { color: #64748b; font-size: 9px; text-transform: uppercase; display: block; font-weight: 600; }
        .facility-box { background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 14px; padding: 12px 14px; margin-bottom: 16px; font-size: 11px; }
        .facility-title { font-size: 9px; text-transform: uppercase; color: ${BRAND.mark}; font-weight: 700; margin-bottom: 2px; }
        .facility-name { color: #f1f5f9; font-weight: 600; }
        .card-footer { display: flex; justify-content: space-between; align-items: center; border-top: 1px solid rgba(255, 255, 255, 0.1); padding-top: 14px; font-size: 10px; color: #64748b; }
        .helpline { color: ${BRAND.mark}; font-weight: 700; }
      </style>
    </head>
    <body>
      <div class="card-container">
        <div class="card-glow"></div>
        <div class="card-header">
          <div>
            <div class="agency-title">${orgName}</div>
          </div>
          <div class="badge">ACTIVE</div>
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
              ${
                data.planType || data.ageOrDob
                  ? `<div class="info-row">
                <span class="info-label">${data.planType ? 'Service' : 'Age'}</span>
                ${data.planType ?? ''} ${data.ageOrDob ? `${data.planType ? '• Age: ' : ''}${data.ageOrDob}` : ''}
              </div>`
                  : ''
              }
              ${
                data.residentialAddress || data.lga || data.nin
                  ? `<div class="info-row">
                <span class="info-label">Address & LGA</span>
                ${data.residentialAddress ? `${data.residentialAddress}, ` : ''}${data.lga ?? ''} ${data.nin ? `• NIN: ${data.nin.slice(0, 4)}***` : ''}
              </div>`
                  : ''
              }
            </div>
          </div>
        </div>

        ${
          data.dependents && data.dependents.length > 0
            ? `
        <div style="background: rgba(116, 186, 3, 0.08); border: 1px dashed rgba(116, 186, 3, 0.3); border-radius: 14px; padding: 10px 14px; margin-bottom: 16px; font-size: 11px;">
          <div style="font-size: 9px; text-transform: uppercase; color: ${BRAND.mark}; font-weight: 700; margin-bottom: 4px;">Registered Dependants (${data.dependents.length})</div>
          <div style="color: #e2e8f0; font-size: 10px; line-height: 1.4;">
            ${data.dependents.map((d) => `• <strong>${d.fullName}</strong> (${d.relationship})`).join('<br/>')}
          </div>
        </div>
        `
            : ''
        }

        ${
          data.preferredHospital
            ? `<div class="facility-box">
          <div class="facility-title">Assigned Location</div>
          <div class="facility-name">${data.preferredHospital}</div>
        </div>`
            : ''
        }

        <div class="card-footer">
          <div>Issued: ${data.issuedAt}</div>
          ${
            // No default number. This read "24/7 Helpline: 0700-700-1111" on
            // every card, for every agency — a number nothing in the platform
            // owns, printed on the artefact a citizen reaches for when they
            // need help. An agency that has published one shows it.
            data.helpline ? `<div>Helpline: <span class="helpline">${data.helpline}</span></div>` : ''
          }
        </div>
      </div>
    </body>
    </html>
    `;

    // Agency-neutral, and every line is omitted when its value is unknown.
    // This used to read "Digital Healthcare ID / Enrollee / Plan / Primary
    // Facility" whatever the agency was, and printed the word `undefined`
    // for whichever of those an agency does not collect.
    const summaryText = [
      `*${orgName} Digital ID*`.trim(),
      `Name: ${data.fullName}`,
      `ID: ${data.policyId}`,
      data.planType ? `Service: ${data.planType}` : null,
      data.preferredHospital ? `Assigned Location: ${data.preferredHospital}` : null,
      data.lga ? `LGA: ${data.lga}` : null,
      'Status: ACTIVE',
    ]
      .filter(Boolean)
      .join('\n');

    return { html, summaryText };
  }
}

