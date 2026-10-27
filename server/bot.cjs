const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const cheerio = require('cheerio');
const { createGoogleRequest } = require('./google-request.cjs');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const CREDENTIALS_PATH = path.join(ROOT, 'credentials.json');
const APP_CONFIG = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {};
const SPREADSHEET_ID = String(APP_CONFIG.sheetId || '').trim();

function logLine(level, message) {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    const labels = { INFO: 'INFO', SCAN: 'SCAN', ORDER: 'ORDER', OK: 'DONE', SKIP: 'SKIP', WARN: 'WARN', ERROR: 'ERROR' };
    console.log(`[${time}] ${labels[level] || level}  ${message}`);
}

async function authorize(tokenPath) {
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
    const key = credentials.installed || credentials.web;
    const oAuth2Client = new google.auth.OAuth2(key.client_id, key.client_secret, 'http://localhost:3210/oauth2callback');
    const token = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
    oAuth2Client.setCredentials(token);
    return oAuth2Client;
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
    let writtenCount = 0;
    let skippedCount = 0;
    const gmail = options.gmail || google.gmail({ version: 'v1', auth });
    const sheets = options.sheets || google.sheets({ version: 'v4', auth });
    const request = options.request || createGoogleRequest({
        onRetry: (attempt, delay) => logLine('WARN', `Google giới hạn/tạm lỗi; thử lại ${attempt}/3 sau ${Math.ceil(delay / 1000)} giây.`)
    });

    try {
        logLine("SCAN", `Account: ${manualAccountName} | Đang quét email...`);

        // ==========================================
        // TÍNH NĂNG MỚI: QUÉT SHEET TÌM DÒNG TRỐNG & LƯU LẠI CÁC ID ĐÃ CÓ
        // ==========================================
        let targetRow = 2;
        let existingOrderIds = new Set(); 

        try {
            const response = await request(requestOptions => sheets.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
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
            logLine("ERROR", `Không thể đọc Google Sheets: ${sheetErr.message}`);
            throw sheetErr;
        }

        const res = await request(requestOptions => gmail.users.messages.list({ userId: 'me', q: 'is:unread {"Order Number" "Order Date"}', maxResults: 25 }, requestOptions));
        const messages = res.data.messages;
        
        if (!messages || messages.length === 0) {
            logLine("INFO", "Không có email mới cần xử lý.");
            return { writtenCount, skippedCount };
        }

        logLine("INFO", `Tìm thấy ${messages.length} email chưa đọc.`);

        for (const msg of messages) {
            const msgId = msg.id;
            const messageData = await request(requestOptions => gmail.users.messages.get({ userId: 'me', id: msgId }, requestOptions));
            const payload = messageData.data.payload;

            const subjectHeader = (payload.headers || []).find(h => h.name.toLowerCase() === 'subject');
            const subjectTitle = subjectHeader ? subjectHeader.value : "Không rõ tiêu đề";


            // Gmail thường chứa cả bản text/plain và text/html của cùng một email.
            // Không ghép cả hai bản vì sẽ khiến một Order ID bị đọc hai lần trong cùng email.
            const htmlBodies = [];
            const plainBodies = [];

            function extractParts(part) {
                if (part.body && part.body.data) {
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
                console.log(`  -> ⚠️ BỎ QUA: Thư này không chứa thông tin Đơn Hàng hợp lệ.`);
            } else {
                let currentImgIndex = 0; 

                for (let i = 1; i < orderBlocks.length; i++) {
                    const block = orderBlocks[i];
                    
                    let orderId = '';
                    const orderMatch = block.match(/([a-fA-F0-9]{24})/);
                    if (orderMatch) orderId = orderMatch[1].trim().toLowerCase();
                    
                    if (!orderId) {
                        canMarkRead = false;
                        console.log(`  -> ⚠️ LỖI NHỎ: Bắt được Đơn nhưng không tìm thấy Mã Order ID (24 ký tự)!`);
                        continue;
                    }

                    // ==========================================
                    // KHIÊN CHỐNG TRÙNG LẶP ĐƠN HÀNG
                    // ==========================================
                    if (existingOrderIds.has(orderId)) {
                        skippedCount++;
                        logLine("SKIP", `Đơn ID ${orderId} đã có trong Sheet.`);
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

                    let dataToWrite = [];
                    for (let k = 0; k < items.length; k++) {
                        const item = items[k];
                        const currentMockup = formatMockupUrl(allImages[currentImgIndex] || ""); 
                        currentImgIndex++;

                        dataToWrite.push({ range: `'${sheetName.replace(/'/g, "''")}'!B${targetRow}`, values: [[orderMonth]] });
                        dataToWrite.push({ range: `'${sheetName.replace(/'/g, "''")}'!C${targetRow}`, values: [[orderDateFmt]] });
                        dataToWrite.push({ range: `'${sheetName.replace(/'/g, "''")}'!F${targetRow}`, values: [[manualAccountName]] });
                        dataToWrite.push({ range: `'${sheetName.replace(/'/g, "''")}'!G${targetRow}`, values: [[item.buyer]] });
                        dataToWrite.push({ range: `'${sheetName.replace(/'/g, "''")}'!H${targetRow}`, values: [[orderId]] });
                        dataToWrite.push({ range: `'${sheetName.replace(/'/g, "''")}'!J${targetRow}`, values: [["1"]] });
                        dataToWrite.push({ range: `'${sheetName.replace(/'/g, "''")}'!K${targetRow}`, values: [["T-shirt"]] });
                        dataToWrite.push({ range: `'${sheetName.replace(/'/g, "''")}'!L${targetRow}`, values: [[item.size]] });
                        dataToWrite.push({ range: `'${sheetName.replace(/'/g, "''")}'!O${targetRow}`, values: [[earnings]] });
                        dataToWrite.push({ range: `'${sheetName.replace(/'/g, "''")}'!R${targetRow}`, values: [[orderId]] });
                        dataToWrite.push({ range: `'${sheetName.replace(/'/g, "''")}'!W${targetRow}`, values: [[currentMockup]] });

                        logLine("ORDER", `Đang ghi đơn ${orderId} | Buyer: ${item.buyer || "N/A"} | Size: ${item.size || "N/A"}`);
                        targetRow++;
                    }

                    if (dataToWrite.length > 0) {
                        await request(requestOptions => sheets.spreadsheets.values.batchUpdate({
                            spreadsheetId: SPREADSHEET_ID,
                            resource: { valueInputOption: 'USER_ENTERED', data: dataToWrite }
                        }, requestOptions));
                        writtenCount += dataToWrite.length / 11;
                        existingOrderIds.add(orderId);
                        logLine("OK", `Đã ghi đơn ${orderId} vào Sheet.`);
                    }
                }
            }

            if (canMarkRead) await request(requestOptions => gmail.users.messages.modify({
                userId: 'me', id: msgId,
                resource: { removeLabelIds: ['UNREAD'] }
            }, requestOptions));
        }
        if (res.data.nextPageToken) logLine('INFO', 'Còn email chưa xử lý. Chạy lại để tiếp tục (tối đa 25 email mỗi lần).');
        logLine("OK", `Hoàn tất account ${manualAccountName} | Đã ghi: ${writtenCount} | Bỏ qua: ${skippedCount}`);
        return { writtenCount, skippedCount };

    } catch (error) {
        error.partialStats = { writtenCount, skippedCount };
        logLine("ERROR", `Dừng xử lý | Đã ghi: ${writtenCount} | Bỏ qua: ${skippedCount} | ${error.message}`);
        throw error;
    }
}

async function main() {
    logLine("INFO", "Khởi động Get Label.");

    const sheetName = String(process.env.PM_SHEET_NAME || "").trim();
    const accountName = String(process.env.PM_ACCOUNT_NAME || "").trim();
    const tokenFile = String(process.env.PM_TOKEN_FILE || "").trim();

    if (!SPREADSHEET_ID) throw new Error("Thiếu sheetId trong config.json.");
    if (!sheetName) throw new Error("Thiếu tên tab Google Sheets.");
    if (!accountName) throw new Error("Thiếu tên account Poshmark.");
    if (!/^token_.+\.json$/i.test(tokenFile)) throw new Error("Tên file token Gmail không hợp lệ.");

    const tokenPath = path.join(ROOT, tokenFile);
    if (!fs.existsSync(tokenPath)) throw new Error(`Không tìm thấy token Gmail: ${tokenFile}`);
    if (!fs.existsSync(CREDENTIALS_PATH)) throw new Error("Không tìm thấy credentials.json trong thư mục gốc.");

    try {
        const auth = await authorize(tokenPath);
        const stats = await processOrders(auth, accountName, sheetName);
        logLine("OK", `GET LABEL HOÀN TẤT | Account: ${accountName} | Đã ghi: ${stats?.writtenCount ?? 0} | Bỏ qua: ${stats?.skippedCount ?? 0}`);
        console.log("────────────────────────────────────────────────");
    } catch (err) {
        logLine("ERROR", `Get Label thất bại: ${err.message}`);
        process.exitCode = 1;
    }
}

module.exports = { processOrders };

if (require.main === module) main().catch(error => {
    logLine("ERROR", `Get Label thất bại: ${error.message}`);
    process.exitCode = 1;
});
