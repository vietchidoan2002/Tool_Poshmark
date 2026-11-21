const { google } = require('googleapis');
const cheerio = require('cheerio');
const { createGoogleRequest } = require('./google-request.cjs');
const { MAX_PDF_BYTES, pdfParts, trackingInOrder, loadLabelBatch } = require('./gmail-labels.cjs');

function logLine(level, message) {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    const labels = { INFO: 'INFO', SCAN: 'SCAN', ORDER: 'ORDER', OK: 'DONE', SKIP: 'SKIP', WARN: 'WARN', ERROR: 'ERROR' };
    console.log(`[${time}] ${labels[level] || level}  ${message}`);
}

function formatMockupUrl(url) {
    if (!url) return "";
    try {
        let formatted = url.replace(/\/m_/, '/l_wp_');
        formatted = formatted.replace(/\.[^/.]+$/, '.webp');
        return formatted;
    } catch (e) { return url; }
}

async function processOrders(auth, manualAccountName, sheetName, options = {}) {
    const log = options.log || logLine;
    const { spreadsheetId } = options;
    let writtenCount = 0;
    let writtenOrderCount = 0;
    let skippedCount = 0;
    const prepareDrive = options.prepareDrive === true;
    const labelBatches = options.includeLabels || prepareDrive ? [] : null;
    const plannedOrders = [];
    const labelBudget = { bytes: MAX_PDF_BYTES, files: 0 };
    const stats = () => ({
        writtenCount, writtenOrderCount, skippedCount,
        ...(labelBatches ? { labelBatches } : {}),
        ...(prepareDrive ? { plannedOrders } : {}),
    });
    const gmail = options.gmail || google.gmail({ version: 'v1', auth });
    const sheets = options.sheets || google.sheets({ version: 'v4', auth });
    const request = options.request || createGoogleRequest({
        onRetry: (attempt, delay) => log('WARN', `Google giới hạn/tạm lỗi; thử lại ${attempt}/3 sau ${Math.ceil(delay / 1000)} giây.`)
    });

    try {
        log("SCAN", `Account: ${manualAccountName} | Đang quét email...`);

        // ==========================================
        // TÍNH NĂNG MỚI: QUÉT SHEET TÌM DÒNG TRỐNG & LƯU LẠI CÁC ID ĐÃ CÓ
        // ==========================================
        let targetRow = 2;
        let existingOrderIds = new Set(); 

        if (!prepareDrive) try {
            const response = await request(requestOptions => sheets.spreadsheets.values.get({
                spreadsheetId,
                range: `'${sheetName.replace(/'/g, "''")}'!H:H`,
            }, requestOptions));
            const rows = response.data.values;
            let lastDataRow = 1;
            
            if (rows) {
                for (let r = 0; r < rows.length; r++) {
                    if (rows[r] && rows[r][0]) {
                        const val = String(rows[r][0]).trim().toLowerCase();
                        if (val !== "") {
                            existingOrderIds.add(val); // Lưu ID vào bộ nhớ để chống trùng
                            if (val.toLowerCase() !== "id order") {
                                lastDataRow = r + 1;
                            }
                        }
                    }
                }
            }
            targetRow = Math.max(lastDataRow + 1, 2);
        } catch (sheetErr) {
            log("ERROR", `Không thể đọc Google Sheets: ${sheetErr.message}`);
            throw sheetErr;
        }

        const query = prepareDrive
            ? 'is:unread {subject:"Your shipping labels are inside" (has:attachment filename:pdf {"Order Number" "Order Date"})}'
            : labelBatches
              ? 'is:unread {"Order Number" "Order Date" subject:"Your shipping labels are inside"}'
              : 'is:unread {"Order Number" "Order Date"}';
        const res = await request(requestOptions => gmail.users.messages.list({ userId: 'me', q: query, maxResults: 25 }, requestOptions));
        const messages = res.data.messages;
        
        if (!messages || messages.length === 0) {
            log("INFO", "Không có email mới cần xử lý.");
            return stats();
        }

        log("INFO", `Tìm thấy ${messages.length} email chưa đọc.`);

        for (const msg of messages) {
            const msgId = msg.id;
            const messageData = await request(requestOptions => gmail.users.messages.get({ userId: 'me', id: msgId }, requestOptions));
            const payload = messageData.data.payload;
            const attachments = labelBatches ? pdfParts(payload) : [];
            const labelOrders = [];

            const subjectHeader = (payload.headers || []).find(h => h.name.toLowerCase() === 'subject');
            const subjectTitle = subjectHeader ? subjectHeader.value : "Không rõ tiêu đề";


            // Gmail thường chứa cả bản text/plain và text/html của cùng một email.
            // Không ghép cả hai bản vì sẽ khiến một Order ID bị đọc hai lần trong cùng email.
            const htmlBodies = [];
            const plainBodies = [];

            function extractParts(part) {
                if (part.body?.data && ['text/html', 'text/plain'].includes(part.mimeType)) {
                    const decoded = Buffer.from(
                        part.body.data.replace(/-/g, '+').replace(/_/g, '/'),
                        'base64'
                    ).toString('utf-8');
                    if (part.mimeType === 'text/html') htmlBodies.push(decoded);
                    else if (part.mimeType === 'text/plain') plainBodies.push(decoded);
                }
                if (part.parts) part.parts.forEach(extractParts);
            }
            extractParts(payload);
            let emailBodyRaw = htmlBodies.length
                ? htmlBodies.join(' ')
                : plainBodies.join(' ');

            emailBodyRaw = emailBodyRaw.replace(/<br[^>]*>/gi, ' \n ')
                                       .replace(/<\/div>/gi, ' \n ')
                                       .replace(/<\/p>/gi, ' \n ')
                                       .replace(/<\/td>/gi, ' \t ')
                                       .replace(/<\/th>/gi, ' \t ')
                                       .replace(/<\/tr>/gi, ' \n ');

            const $ = cheerio.load(emailBodyRaw);
            const plainText = $.text();
            
            // ==========================================
            // MÀNG LỌC ẢNH: CHẶN ĐỨNG MỌI PIXEL THEO DÕI VÀ ICON RÁC
            // ==========================================
            let allImages = [];
            $('img').each((i, el) => {
                const originalSrc = $(el).attr('src');
                if (!originalSrc) return;
                
                const src = originalSrc.toLowerCase();
                if (!src.includes('logo') && 
                    !src.includes('pixel') && 
                    !src.includes('icon') && 
                    !src.includes('tr.poshmark.com') && // <-- Chặn link gây lỗi của bạn
                    !src.includes('facebook') && 
                    !src.includes('twitter') && 
                    !src.includes('pinterest') && 
                    !src.includes('instagram')
                ) {
                    allImages.push(originalSrc);
                }
            });

            // SỬA LỖI LỆCH ID: Nếu thư có "Order Number" (nằm đầu mỗi đơn) thì cắt theo "Order Number", ngược lại mới cắt theo "Order Date"
            let orderBlocks = [];
            if (plainText.match(/Order\s*Number/i)) {
                orderBlocks = plainText.split(/Order\s*Number/i);
            } else if (plainText.match(/Order\s*Date/i)) {
                orderBlocks = plainText.split(/Order\s*Date/i);
            }

            let canMarkRead = orderBlocks.length > 1;
            if (orderBlocks.length <= 1) {
                log("INFO", `  -> ⚠️ BỎ QUA: Thư này không chứa thông tin Đơn Hàng hợp lệ.`);
            } else {
                let currentImgIndex = 0; 

                for (let i = 1; i < orderBlocks.length; i++) {
                    const block = orderBlocks[i];
                    
                    let orderId = '';
                    const orderMatch = block.match(/\b([a-fA-F0-9]{24})\b/);
                    if (orderMatch) orderId = orderMatch[1].trim().toLowerCase();
                    
                    if (!orderId) {
                        canMarkRead = false;
                        log("INFO", `  -> ⚠️ LỖI NHỎ: Bắt được Đơn nhưng không tìm thấy Mã Order ID (24 ký tự)!`);
                        continue;
                    }

                    if (attachments.length || prepareDrive)
                        labelOrders.push({ orderId, tracking: trackingInOrder(block) });

                    // ==========================================
                    // KHIÊN CHỐNG TRÙNG LẶP ĐƠN HÀNG
                    // ==========================================
                    if (existingOrderIds.has(orderId)) {
                        skippedCount++;
                        log("SKIP", `Đơn ID ${orderId} đã có trong Sheet.`);
                        // Vẫn tăng biến đếm ảnh để các đơn chưa có bên dưới không bị lấy nhầm ảnh của đơn đã bỏ qua
                        const skippedItemsCount = Math.max(block.split(/Size:/i).length - 1, 1);
                        currentImgIndex += skippedItemsCount;
                        continue;
                    }
                    let orderMonth = '', orderDateFmt = '';
                    const dateMatch = block.match(/([A-Za-z]+\s+\d{1,2},\s+\d{4})/i);
                    if (dateMatch) {
                        const dateObj = new Date(dateMatch[1]);
                        if (!isNaN(dateObj.getTime())) {
                            orderMonth = (dateObj.getMonth() + 1).toString();
                            orderDateFmt = `${dateObj.getDate().toString().padStart(2, '0')}/${(dateObj.getMonth() + 1).toString().padStart(2, '0')}`;
                        }
                    }
                    if (!orderMonth) {
                        const now = new Date();
                        orderMonth = (now.getMonth() + 1).toString();
                        orderDateFmt = `${now.getDate().toString().padStart(2, '0')}/${(now.getMonth() + 1).toString().padStart(2, '0')}`;
                    }

                    let earnings = '';
                    const earnMatch = block.match(/(?:taxes\)|Earnings[\s\S]*?)(?:\$)\s*([0-9.]+)/i);
                    if (earnMatch) {
                        earnings = earnMatch[1].trim();
                        if (earnings.endsWith('.00')) earnings = earnings.replace('.00', '');
                        else earnings = earnings.replace('.', ',');
                    }

                    // Bắt sẵn Buyer nằm ở đầu đơn (dành cho mẫu mail có Buyer nằm trên chữ Size)
                    let defaultBuyer = '';
                    const topBuyerMatch = block.match(/Buyer:?\s*[\s\S]{0,30}?@([a-zA-Z0-9_.-]+)/i);
                    if (topBuyerMatch) {
                        defaultBuyer = topBuyerMatch[1].replace(/Price$/i, '').replace(/Order$/i, '').trim();
                    }

                    const itemParts = block.split(/Size:/i);
                    let items = [];

                    if (itemParts.length > 1) {
                        for (let k = 1; k < itemParts.length; k++) {
                            let part = itemParts[k];

                            let sizeMatch = part.match(/^\s*(.*?)\s*Buyer:/i) || part.match(/^\s*([^\n\r\t$@]+)/i);
                            let size = sizeMatch ? sizeMatch[1].replace(/^US\s*/i, '').trim() : '';

                            let buyerMatch = part.match(/Buyer:?\s*[\s\S]{0,30}?@([a-zA-Z0-9_.-]+)/i);
                            let buyer = buyerMatch ? buyerMatch[1].replace(/Price$/i, '').trim() : '';
                            
                            if (buyer) defaultBuyer = buyer; 
                            else buyer = defaultBuyer;

                            items.push({ size, buyer });
                        }
                    } else {
                        items.push({ size: '', buyer: defaultBuyer });
                    }

                    const dataToWrite = [];
                    const plannedRows = [];
                    for (let k = 0; k < items.length; k++) {
                        const item = items[k];
                        const currentMockup = formatMockupUrl(allImages[currentImgIndex] || ""); 
                        currentImgIndex++;

                        const values = {
                            B: orderMonth,
                            C: orderDateFmt,
                            F: manualAccountName,
                            G: item.buyer,
                            H: orderId,
                            J: "1",
                            K: "T-shirt",
                            L: item.size,
                            O: earnings,
                            R: orderId,
                            W: currentMockup,
                        };
                        if (prepareDrive) {
                            plannedRows.push(values);
                        } else {
                            for (const [column, value] of Object.entries(values))
                                dataToWrite.push({
                                    range: `'${sheetName.replace(/'/g, "''")}'!${column}${targetRow}`,
                                    values: [[value]],
                                });
                            log("ORDER", `Đang ghi đơn ${orderId} | Buyer: ${item.buyer || "N/A"} | Size: ${item.size || "N/A"}`);
                        }
                        targetRow++;
                    }

                    if (prepareDrive) {
                        plannedOrders.push({ orderId, rows: plannedRows });
                        existingOrderIds.add(orderId);
                    } else if (dataToWrite.length > 0) {
                        await request(requestOptions => sheets.spreadsheets.values.batchUpdate({
                            spreadsheetId,
                            resource: { valueInputOption: 'USER_ENTERED', data: dataToWrite }
                        }, requestOptions));
                        writtenCount += dataToWrite.length / 11;
                        writtenOrderCount++;
                        existingOrderIds.add(orderId);
                        log("OK", `Đã ghi đơn ${orderId} vào Sheet.`);
                    }
                }
            }

            if (attachments.length || prepareDrive) {
                const batch = await loadLabelBatch({
                    gmail, request, messageId: msgId, parts: attachments, orders: labelOrders,
                    budget: labelBudget, canMarkRead,
                });
                if (prepareDrive && !attachments.length) batch.issues.push("Email thiếu PDF tem đính kèm.");
                if (prepareDrive && !canMarkRead) batch.issues.push("Email có thông tin đơn thiếu hoặc không xác định được Order ID.");
                labelBatches.push(batch);
            } else if (canMarkRead) await request(requestOptions => gmail.users.messages.modify({
                userId: 'me', id: msgId,
                resource: { removeLabelIds: ['UNREAD'] }
            }, requestOptions));
        }
        if (res.data.nextPageToken) log('INFO', 'Còn email chưa xử lý. Chạy lại để tiếp tục (tối đa 25 email mỗi lần).');
        if (!prepareDrive)
            log("OK", `Hoàn tất account ${manualAccountName} | Đã ghi: ${writtenCount} | Bỏ qua: ${skippedCount}`);
        return stats();

    } catch (error) {
        error.partialStats = stats();
        log("ERROR", `Dừng xử lý | Đã ghi: ${writtenCount} | Bỏ qua: ${skippedCount} | ${error.message}`);
        throw error;
    }
}

module.exports = { processOrders };
