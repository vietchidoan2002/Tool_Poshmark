const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const cheerio = require('cheerio');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (query) => new Promise((resolve) => rl.question(query, resolve));

const CONFIG_PATH = path.join(process.cwd(), 'config.json');
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');

// ID Sheet của bạn
const APP_CONFIG_PATH = path.join(process.cwd(), 'config.json');
const APP_CONFIG = fs.existsSync(APP_CONFIG_PATH) ? JSON.parse(fs.readFileSync(APP_CONFIG_PATH, 'utf8')) : {};
const SPREADSHEET_ID = String(APP_CONFIG.sheetId || '').trim();

async function authorize(tokenPath) {
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
    const key = credentials.installed || credentials.web;
    const oAuth2Client = new google.auth.OAuth2(key.client_id, key.client_secret, 'http://localhost');
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

async function processOrders(auth, manualAccountName) {
    const gmail = google.gmail({ version: 'v1', auth });
    const sheets = google.sheets({ version: 'v4', auth });

    try {
        console.log(`\n[Tài khoản đang quét] Đang kiểm tra mail...`);

        // ==========================================
        // TÍNH NĂNG MỚI: QUÉT SHEET TÌM DÒNG TRỐNG & LƯU LẠI CÁC ID ĐÃ CÓ
        // ==========================================
        let targetRow = 2;
        let existingOrderIds = new Set(); 

        try {
            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: "'Đơn poshmark'!H:H",
            });
            const rows = response.data.values;
            let lastDataRow = 1;
            
            if (rows) {
                for (let r = 0; r < rows.length; r++) {
                    if (rows[r] && rows[r][0]) {
                        const val = rows[r][0].trim();
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
            console.error(`❌ Lỗi API Google Sheet. Vui lòng kiểm tra lại quyền!`);
            return;
        }

        const res = await gmail.users.messages.list({ userId: 'me', q: 'is:unread' });
        const messages = res.data.messages;
        
        if (!messages || messages.length === 0) {
            console.log(`[Tài khoản này] Không có thư nào mới.`);
            return;
        }

        console.log(`[Tài khoản này] Có ${messages.length} thư chưa đọc. Đang phân tích...`);

        for (const msg of messages) {
            const msgId = msg.id;
            const messageData = await gmail.users.messages.get({ userId: 'me', id: msgId });
            const payload = messageData.data.payload;

            const subjectHeader = payload.headers.find(h => h.name.toLowerCase() === 'subject');
            const subjectTitle = subjectHeader ? subjectHeader.value : "Không rõ tiêu đề";
            console.log(`\n📧 Đang xử lý thư: "${subjectTitle}"`);

            let emailBodyRaw = '';
            
            function extractParts(part) {
                if (part.body && part.body.data) {
                    let decoded = Buffer.from(part.body.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
                    if (part.mimeType === 'text/html') {
                        emailBodyRaw += decoded + ' ';
                    } else if (part.mimeType === 'text/plain' && !emailBodyRaw.includes('<html')) {
                        emailBodyRaw += decoded + ' ';
                    }
                }
                if (part.parts) part.parts.forEach(extractParts);
            }
            extractParts(payload);

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

            if (orderBlocks.length <= 1) {
                console.log(`  -> ⚠️ BỎ QUA: Thư này không chứa thông tin Đơn Hàng hợp lệ.`);
            } else {
                let currentImgIndex = 0; 

                for (let i = 1; i < orderBlocks.length; i++) {
                    const block = orderBlocks[i];
                    
                    let orderId = '';
                    const orderMatch = block.match(/([a-fA-F0-9]{24})/);
                    if (orderMatch) orderId = orderMatch[1].trim();
                    
                    if (!orderId) {
                        console.log(`  -> ⚠️ LỖI NHỎ: Bắt được Đơn nhưng không tìm thấy Mã Order ID (24 ký tự)!`);
                        continue;
                    }

                    // ==========================================
                    // KHIÊN CHỐNG TRÙNG LẶP ĐƠN HÀNG
                    // ==========================================
                    if (existingOrderIds.has(orderId)) {
                        console.log(`  -> ⏭️ BỎ QUA: Đơn ID [${orderId}] đã có trong Sheet rồi (Poshmark gửi nhiều mail trùng).`);
                        // Vẫn tăng biến đếm ảnh để các đơn chưa có bên dưới không bị lấy nhầm ảnh của đơn đã bỏ qua
                        const skippedItemsCount = Math.max(block.split(/Size:/i).length - 1, 1);
                        currentImgIndex += skippedItemsCount;
                        continue;
                    }
                    existingOrderIds.add(orderId); // Lưu ngay vào bộ nhớ để các thư quét sau không bị trùng

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

                        dataToWrite.push({ range: `'Đơn poshmark'!B${targetRow}`, values: [[orderMonth]] });
                        dataToWrite.push({ range: `'Đơn poshmark'!C${targetRow}`, values: [[orderDateFmt]] });
                        dataToWrite.push({ range: `'Đơn poshmark'!F${targetRow}`, values: [[manualAccountName]] });
                        dataToWrite.push({ range: `'Đơn poshmark'!G${targetRow}`, values: [[item.buyer]] });
                        dataToWrite.push({ range: `'Đơn poshmark'!H${targetRow}`, values: [[orderId]] });
                        dataToWrite.push({ range: `'Đơn poshmark'!J${targetRow}`, values: [["1"]] });
                        dataToWrite.push({ range: `'Đơn poshmark'!K${targetRow}`, values: [["T-shirt"]] });
                        dataToWrite.push({ range: `'Đơn poshmark'!L${targetRow}`, values: [[item.size]] });
                        dataToWrite.push({ range: `'Đơn poshmark'!O${targetRow}`, values: [[earnings]] });
                        dataToWrite.push({ range: `'Đơn poshmark'!R${targetRow}`, values: [[orderId]] });
                        dataToWrite.push({ range: `'Đơn poshmark'!W${targetRow}`, values: [[currentMockup]] });

                        console.log(`  -> SẴN SÀNG GHI (Áo ${k+1}/${items.length}): ID ${orderId} | Buyer: ${item.buyer} | Size: ${item.size} | Earn: ${earnings}`);
                        targetRow++;
                    }

                    if (dataToWrite.length > 0) {
                        await sheets.spreadsheets.values.batchUpdate({
                            spreadsheetId: SPREADSHEET_ID,
                            resource: { valueInputOption: 'USER_ENTERED', data: dataToWrite }
                        });
                        console.log(`  => ✅ ĐÃ GHI THÀNH CÔNG VÀO SHEET!`);
                    }
                }
            }

            await gmail.users.messages.modify({
                userId: 'me', id: msgId,
                resource: { removeLabelIds: ['UNREAD'] }
            });
        }
        console.log(`\n[Xong] Xử lý hoàn tất tài khoản!\n`);

    } catch (error) {
        console.error(`[Lỗi xử lý]:`, error.message);
    }
}

async function main() {
    console.log("KHỞI ĐỘNG TOOL");

    const labelsDir = path.join(process.cwd(), 'labels');
    if (!fs.existsSync(labelsDir)) fs.mkdirSync(labelsDir);

    const files = fs.readdirSync(process.cwd());
    const tokenFiles = files.filter(f => f.startsWith('token_') && f.endsWith('.json'));

    if (tokenFiles.length === 0) {
        console.log("❌ Không tìm thấy file token nào!");
        rl.close();
        return;
    }

    let selectedTokens = [];

    if (tokenFiles.length > 1) {
        console.log(`\n🚀 Tìm thấy ${tokenFiles.length} tài khoản. Vui lòng chọn tài khoản muốn xử lý:`);
        tokenFiles.forEach((file, index) => {
            const acc = file.replace('token_', '').replace('.json', '');
            console.log(`   [${index + 1}] ${acc}`);
        });
        console.log(`   [0] Chạy TẤT CẢ các tài khoản`);

        let choice = await question(`\n👉 Nhập số (0-${tokenFiles.length}): `);
        let choiceIndex = parseInt(choice.trim());

        if (!isNaN(choiceIndex) && choiceIndex > 0 && choiceIndex <= tokenFiles.length) {
            selectedTokens = [tokenFiles[choiceIndex - 1]];
            console.log(`\n✅ Bạn đã chọn chạy tài khoản: ${selectedTokens[0].replace('token_', '').replace('.json', '')}`);
        } else {
            console.log(`\n✅ Bạn đã chọn chạy TẤT CẢ tài khoản.`);
            selectedTokens = tokenFiles; 
        }
    } else {
        selectedTokens = tokenFiles;
    }

    for (const tokenFile of selectedTokens) {
        const defaultAccName = tokenFile.replace('token_', '').replace('.json', '').replace('@gmail.com', '');
        
        const inputAcc = await question(`👉 Nhập tên Account muốn điền Cột F (Enter để mặc định): `);
        const finalAccName = inputAcc.trim() !== "" ? inputAcc.trim() : defaultAccName;

        try {
            const auth = await authorize(tokenFile);
            await processOrders(auth, finalAccName);
        } catch (err) {
            console.error(`❌ Lỗi xác thực tài khoản [${tokenFile}]:`, err.message);
        }
    }
    
    console.log("✅ TOÀN BỘ TIẾN TRÌNH ĐÃ HOÀN TẤT!");
    rl.close();
}

main();