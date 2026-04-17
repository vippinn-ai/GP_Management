import { jsPDF } from "jspdf";
import * as XLSX from "xlsx";
import brandLogo from "../Branding/Logo.png";
import type { Bill, BusinessProfile } from "./types";
import { currency, downloadBlob, escapeHtml, formatDateTime } from "./utils";

interface ReportRow {
  billNumber: string;
  date: string;
  station: string;
  customer: string;
  paymentMode: string;
  total: number;
  status: string;
}

interface ReceiptDisplayEntry {
  id: string;
  title: string;
  detail: string;
  amount: string;
  isDiscount?: boolean;
}

interface ReceiptPreviewModel {
  brandTitle: string;
  brandSubtitle: string;
  infoLines: string[];
  metaRows: Array<{ label: string; value: string }>;
  entries: ReceiptDisplayEntry[];
  subtotal: string;
  discount: string;
  roundOff?: string;
  total: string;
  footer: string;
}

export function exportRowsToCsv(rows: ReportRow[], filename: string): void {
  const header = ["Bill Number", "Date", "Station", "Customer", "Payment Mode", "Total", "Status"];
  const lines = [header.join(",")];

  for (const row of rows) {
    lines.push(
      [
        row.billNumber,
        row.date,
        row.station,
        row.customer,
        row.paymentMode,
        row.total.toFixed(2),
        row.status
      ]
        .map((cell) => `"${String(cell).replaceAll('"', '""')}"`)
        .join(",")
    );
  }

  downloadBlob(new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" }), filename);
}

export function exportRowsToXlsx(rows: ReportRow[], filename: string): void {
  const sheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Daily Report");
  const output = XLSX.write(workbook, { bookType: "xlsx", type: "array" });
  downloadBlob(
    new Blob([output], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    }),
    filename
  );
}

export function exportRowsToPdf(rows: ReportRow[], filename: string, businessName: string): void {
  const pdf = new jsPDF({ unit: "pt", format: "a4" });
  let y = 48;

  pdf.setFontSize(18);
  pdf.text(`${businessName} Daily Report`, 40, y);
  y += 24;
  pdf.setFontSize(10);
  pdf.text(`Generated: ${new Date().toLocaleString("en-IN")}`, 40, y);
  y += 28;

  pdf.setFontSize(9);
  for (const row of rows) {
    const line = `${row.billNumber} | ${row.date} | ${row.station} | ${row.customer} | ${row.paymentMode.toUpperCase()} | ${currency(row.total)} | ${row.status}`;
    const wrapped = pdf.splitTextToSize(line, 520);
    pdf.text(wrapped, 40, y);
    y += wrapped.length * 12 + 4;
    if (y > 780) {
      pdf.addPage();
      y = 48;
    }
  }

  pdf.save(filename);
}

export async function downloadReceiptPdf(business: BusinessProfile, bill: Bill, allBills?: Bill[]): Promise<void> {
  const receipt = buildReceiptPreviewModel(business, bill, allBills);
  const pageWidth = 226.77;
  const horizontalPadding = 16;
  const contentWidth = pageWidth - horizontalPadding * 2;
  const estimatedHeight = 320 + receipt.entries.length * 28 + receipt.infoLines.length * 12;
  const pdf = new jsPDF({ unit: "pt", format: [pageWidth, estimatedHeight] });
  let y = 16;

  try {
    const logoImage = await loadImage(brandLogo);
    const logoWidth = 94;
    const logoHeight = 58;
    const logoPanelPaddingX = 10;
    const logoPanelPaddingY = 8;
    const logoPanelWidth = logoWidth + logoPanelPaddingX * 2;
    const logoPanelHeight = logoHeight + logoPanelPaddingY * 2;
    const logoPanelX = (pageWidth - logoPanelWidth) / 2;
    pdf.setFillColor(5, 5, 5);
    pdf.roundedRect(logoPanelX, y, logoPanelWidth, logoPanelHeight, 12, 12, "F");
    pdf.addImage(
      logoImage,
      "PNG",
      logoPanelX + logoPanelPaddingX,
      y + logoPanelPaddingY,
      logoWidth,
      logoHeight,
      undefined,
      "FAST"
    );
    y += logoPanelHeight + 10;
  } catch {
    y += 8;
  }

  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(15);
  pdf.text(receipt.brandTitle, pageWidth / 2, y, { align: "center" });
  y += 14;
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(9);
  pdf.text(receipt.brandSubtitle, pageWidth / 2, y, { align: "center" });
  y += 12;

  pdf.setTextColor(82, 99, 87);
  for (const line of receipt.infoLines) {
    const wrapped = pdf.splitTextToSize(line, contentWidth);
    for (const segment of wrapped) {
      pdf.text(segment, pageWidth / 2, y, { align: "center" });
      y += 10;
    }
  }
  pdf.setTextColor(17, 24, 19);
  y += 4;
  drawDivider(pdf, horizontalPadding, y, pageWidth);
  y += 12;

  pdf.setFontSize(8.5);
  for (const row of receipt.metaRows) {
    pdf.setFont("helvetica", "normal");
    pdf.text(row.label, horizontalPadding, y);
    pdf.text(row.value, pageWidth - horizontalPadding, y, { align: "right" });
    y += 11;
  }

  y += 2;
  drawDivider(pdf, horizontalPadding, y, pageWidth);
  y += 12;

  for (const entry of receipt.entries) {
    pdf.setFont("helvetica", entry.isDiscount ? "normal" : "bold");
    pdf.setFontSize(9);
    const titleLines = pdf.splitTextToSize(entry.title, contentWidth - 56);
    pdf.text(titleLines, horizontalPadding, y);
    pdf.text(entry.amount, pageWidth - horizontalPadding, y, { align: "right" });
    y += titleLines.length * 10;

    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(8);
    const detailLines = pdf.splitTextToSize(entry.detail, contentWidth);
    pdf.text(detailLines, horizontalPadding, y);
    y += detailLines.length * 9 + 6;
  }

  drawDivider(pdf, horizontalPadding, y, pageWidth);
  y += 12;

  y = drawTotalRow(pdf, "Subtotal", receipt.subtotal, horizontalPadding, pageWidth, y);
  y = drawTotalRow(pdf, "Discount", receipt.discount, horizontalPadding, pageWidth, y);
  if (receipt.roundOff) {
    y = drawTotalRow(pdf, "Round Off", receipt.roundOff, horizontalPadding, pageWidth, y);
  }
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(11);
  pdf.text("Total", horizontalPadding, y);
  pdf.text(receipt.total, pageWidth - horizontalPadding, y, { align: "right" });
  y += 18;

  drawDivider(pdf, horizontalPadding, y, pageWidth);
  y += 14;
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(8.5);
  const footerLines = pdf.splitTextToSize(receipt.footer, contentWidth);
  for (const line of footerLines) {
    pdf.text(line, pageWidth / 2, y, { align: "center" });
    y += 9;
  }

  pdf.save(`${bill.billNumber}.pdf`);
}

export function openReceiptWindow(business: BusinessProfile, bill: Bill, allBills?: Bill[]): void {
  const receipt = buildReceiptPreviewModel(business, bill, allBills);
  const receiptHtml = `
    <html>
      <head>
        <title>Receipt ${escapeHtml(bill.billNumber)}</title>
        <style>
          @page { size: 80mm auto; margin: 6mm; }
          * { box-sizing: border-box; }
          body { margin: 0; font-family: Arial, sans-serif; background: #f4f5f2; color: #101816; }
          .receipt-shell { width: 76mm; margin: 0 auto; background: #fff; padding: 5mm 4mm; }
          .receipt-brand { text-align: center; }
          .receipt-logo-shell { width: fit-content; margin: 0 auto 2.5mm; padding: 2.2mm 3.2mm; border-radius: 5mm; background: #050505; }
          .receipt-logo { width: 34mm; height: auto; display: block; margin: 0 auto; }
          .receipt-brand-title { font-size: 15px; font-weight: 800; letter-spacing: 0.08em; }
          .receipt-brand-subtitle { font-size: 10px; margin-top: 1mm; }
          .receipt-info { margin-top: 2.5mm; font-size: 8.5px; line-height: 1.45; color: #566356; text-align: center; }
          .receipt-divider { border-top: 1px dashed #c9d0cb; margin: 3mm 0; }
          .receipt-meta-row, .receipt-total-row { display: flex; justify-content: space-between; gap: 2mm; font-size: 9px; margin-bottom: 1.5mm; }
          .receipt-entry { margin-bottom: 3mm; }
          .receipt-entry-head { display: flex; justify-content: space-between; gap: 2mm; align-items: flex-start; }
          .receipt-entry-title { font-size: 9.5px; font-weight: 700; }
          .receipt-entry.receipt-discount .receipt-entry-title { font-weight: 600; }
          .receipt-entry-amount { font-size: 9.5px; font-weight: 700; white-space: nowrap; }
          .receipt-entry-detail { font-size: 8px; color: #566356; margin-top: 1mm; line-height: 1.4; }
          .receipt-total-row strong { font-size: 11px; }
          .receipt-footer { margin-top: 4mm; font-size: 8.5px; color: #566356; text-align: center; }
          @media print {
            body { background: #fff; }
            .receipt-shell { width: 100%; padding: 0; }
            .receipt-logo-shell { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          }
        </style>
      </head>
      <body>
        <div class="receipt-shell">
          <div class="receipt-brand">
            <div class="receipt-logo-shell">
              <img class="receipt-logo" src="${brandLogo}" alt="Logo" />
            </div>
            <div class="receipt-brand-title">${escapeHtml(receipt.brandTitle)}</div>
            <div class="receipt-brand-subtitle">${escapeHtml(receipt.brandSubtitle)}</div>
          </div>
          <div class="receipt-info">
            ${receipt.infoLines.map((line) => `<div>${escapeHtml(line)}</div>`).join("")}
          </div>
          <div class="receipt-divider"></div>
          ${receipt.metaRows
            .map(
              (row) => `
                <div class="receipt-meta-row">
                  <span>${escapeHtml(row.label)}</span>
                  <strong>${escapeHtml(row.value)}</strong>
                </div>
              `
            )
            .join("")}
          <div class="receipt-divider"></div>
          ${receipt.entries
            .map(
              (entry) => `
                <div class="receipt-entry ${entry.isDiscount ? "receipt-discount" : ""}">
                  <div class="receipt-entry-head">
                    <div class="receipt-entry-title">${escapeHtml(entry.title)}</div>
                    <div class="receipt-entry-amount">${escapeHtml(entry.amount)}</div>
                  </div>
                  <div class="receipt-entry-detail">${escapeHtml(entry.detail)}</div>
                </div>
              `
            )
            .join("")}
          <div class="receipt-divider"></div>
          <div class="receipt-total-row">
            <span>Subtotal</span>
            <strong>${escapeHtml(receipt.subtotal)}</strong>
          </div>
          <div class="receipt-total-row">
            <span>Discount</span>
            <strong>${escapeHtml(receipt.discount)}</strong>
          </div>
          ${
            receipt.roundOff
              ? `
          <div class="receipt-total-row">
            <span>Round Off</span>
            <strong>${escapeHtml(receipt.roundOff)}</strong>
          </div>
          `
              : ""
          }
          <div class="receipt-total-row">
            <span><strong>Total</strong></span>
            <strong>${escapeHtml(receipt.total)}</strong>
          </div>
          <div class="receipt-divider"></div>
          <div class="receipt-footer">${escapeHtml(receipt.footer)}</div>
        </div>
      </body>
    </html>
  `;

  const receiptWindow = window.open("", "_blank", "width=420,height=720");
  receiptWindow?.document.write(receiptHtml);
  receiptWindow?.document.close();
}

export function buildReceiptPreviewModel(business: BusinessProfile, bill: Bill, allBills?: Bill[]): ReceiptPreviewModel {
  const brand = getReceiptBrandHeader(business);
  const replacementOfBill = bill.replacementOfBillId
    ? allBills?.find((entry) => entry.id === bill.replacementOfBillId)
    : undefined;
  const replacedByBill = bill.replacedByBillId
    ? allBills?.find((entry) => entry.id === bill.replacedByBillId)
    : undefined;
  const infoLines = [business.address, business.primaryPhone, business.secondaryPhone].filter(Boolean) as string[];
  const entries: ReceiptDisplayEntry[] = [
    ...bill.lines.map((line) => ({
      id: line.id,
      title: line.description,
      detail: `${line.quantity} × ${currency(line.unitPrice)}`,
      amount: currency(line.subtotal)  // show undiscounted line total; discounts shown as separate entries below
    })),
    ...bill.lineDiscounts.map((discount) => ({
      id: discount.id,
      title: `Discount`,
      detail: discount.reason,
      amount: `-${currency(discount.amount)}`,
      isDiscount: true
    }))
  ];

  return {
    brandTitle: brand.title,
    brandSubtitle: brand.subtitle,
    infoLines,
    metaRows: [
      { label: "Bill No", value: bill.billNumber },
      { label: "Issued At", value: formatDateTime(bill.issuedAt) },
      { label: "Payment", value: bill.paymentMode.toUpperCase() },
      ...(bill.replacementOfBillId
        ? [{ label: "Replaces", value: replacementOfBill?.billNumber ?? bill.replacementOfBillId }]
        : []),
      ...(bill.replacedByBillId
        ? [{ label: "Superseded By", value: replacedByBill?.billNumber ?? bill.replacedByBillId }]
        : [])
    ],
    entries,
    subtotal: currency(bill.subtotal),
    discount: currency(bill.totalDiscountAmount),
    roundOff:
      bill.roundOffEnabled || Math.abs(bill.roundOffAmount) > 0.0001
        ? currency(bill.roundOffAmount)
        : undefined,
    total: currency(bill.total),
    footer: business.receiptFooter
  };
}

function getReceiptBrandHeader(business: BusinessProfile) {
  const normalizedName = business.name.replace(/\s+/g, " ").trim();
  const match = normalizedName.match(/(.+?)\s+gaming lounge$/i);
  const rawTitle = match ? match[1] : normalizedName;
  return {
    title: rawTitle.replace(/([a-z])([A-Z])/g, "$1 $2").toUpperCase(),
    subtitle: match ? "Gaming Lounge" : ""
  };
}

function drawDivider(pdf: jsPDF, x: number, y: number, pageWidth: number) {
  pdf.setDrawColor(201, 208, 203);
  pdf.setLineDashPattern([2, 2], 0);
  pdf.line(x, y, pageWidth - x, y);
  pdf.setLineDashPattern([], 0);
}

function drawTotalRow(pdf: jsPDF, label: string, value: string, x: number, pageWidth: number, y: number) {
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(9);
  pdf.text(label, x, y);
  pdf.text(value, pageWidth - x, y, { align: "right" });
  return y + 12;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

export type { ReportRow };
