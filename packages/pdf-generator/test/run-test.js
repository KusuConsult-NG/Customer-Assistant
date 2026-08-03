const { PdfGeneratorService } = require('../dist/index.js');
const assert = require('assert');

async function testPdfGenerator() {
  console.log('Testing PDF Generator Service...');

  const result = PdfGeneratorService.generateQuotationDocument({
    quotationNumber: 'QT-2026-001',
    organizationName: 'ApexCare Hospital NG',
    organizationPhone: '+234 1 700 8000',
    customerName: 'Ngozi Okonkwo',
    customerPhone: '+234 802 345 6789',
    items: [
      { description: 'Cardiology Comprehensive Screening', quantity: 1, unitPrice: 45000, totalPrice: 45000 },
      { description: 'ECG Diagnostic Report', quantity: 1, unitPrice: 15000, totalPrice: 15000 },
    ],
    subtotal: 60000,
    tax: 0,
    grandTotal: 60000,
    currency: 'NGN',
    validUntil: '2026-08-15',
  });

  assert.ok(result.html.includes('ApexCare Hospital NG'), 'HTML document should contain organization name');
  assert.ok(result.html.includes('₦60,000'), 'HTML document should contain formatted total');
  assert.ok(result.summaryText.includes('QT-2026-001'), 'Summary text should contain quotation number');

  console.log('✅ ALL PDF GENERATOR TESTS PASSED SUCCESSFULLY!');
}

testPdfGenerator().catch((err) => {
  console.error('❌ PDF Generator Test Failed:', err);
  process.exit(1);
});
