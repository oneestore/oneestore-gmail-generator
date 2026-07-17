/**
 * ONEESTORE — V3 BACKEND (Apps Script)  ::  PHASE 3
 * Pipeline (stage-based) + Dashboard + Gaji, extend V3 sedia ada.
 *
 * Workflow Cloudflare catch-all. NO AdminDirectory / Workspace.
 * Backend handle:
 *   - generate / list / update / delete            (sedia ada)
 *   - assignSale  -> link email<->WhatsApp ke D1 + log komisen SALE   (Phase 2C + BARU)
 *   - transition  -> majukan akaun antara stage + auto-log komisen     (BARU)
 *   - listAccount -> admin letak harga + LISTED (TAKDE komisen)         (BARU)
 *   - dashboard   -> aggregate pipeline + sales                         (BARU)
 *   - gaji        -> aggregate komisen per worker per period            (BARU)
 *
 * KOMISEN (ikut OUTCOME):
 *   keluar CHECKING -> EDITING (pass)  : Dekwan RM1.50
 *   keluar CHECKING -> FLAGGED         : Dekwan RM0.50
 *   keluar EDITING  -> LISTED  (pass)  : Korer  RM2.50
 *   keluar EDITING  -> FLAGGED         : Korer  RM0.50
 *   set harga / List                   : TAKDE komisen
 *   LISTED -> SOLD (serah ke customer) : Admin  RM2.00  (nama dynamic, via assignSale)
 * Idempotent stage-level: satu akaun keluar tiap stage / sold sekali je (no double-pay).
 */

// ====== CONFIG ======
const SHEET_ID       = '1RNPxOgl-uyFVTIMgCuZ89eTfMkxvMPo4PDoD_WaXnCk';   // GMAIL_DATA Sheet ID
const SHEET_NAME     = 'GMAIL_DATA';
const COMMISSION_SHEET_NAME = 'COMMISSION_LOG';
const PAYOUT_SHEET_NAME = 'PAYOUT_LOG';
const EMAIL_DOMAIN   = 'onee.store';
const FIXED_PASSWORD = 'mahal12345';
const BACKUP_FOLDER_NAME = 'Oneestore Backups';   // folder dalam Drive untuk simpan salinan
const PROOF_FOLDER_NAME  = 'Oneestore Proofs';     // folder dalam Drive untuk gambar proof link Konami ID
const BACKUP_KEEP        = 14;                     // simpan 14 backup terkini (auto-buang lama)
const RESET_PIN          = '740901';               // PIN untuk butang Reset (server-side, tak terdedah di frontend)
const TIMEZONE       = 'Asia/Kuala_Lumpur'; // Penang = UTC+8

// Phase 2C — Customer linking (OTP auto-relay)
const LINK_WORKER_URL = 'https://oneestore-link-worker.daniall1841.workers.dev';
const LINK_SECRET     = 'oneestore-link-a8f4e1c93b7d-2026';

// Column order MESTI padan dengan Sheet header row (A..O)
const HEADERS = [
  'Email', 'Password', 'Tarikh', 'Player List', 'Harga Jual', 'Supplier', 'Stage',
  'Customer WhatsApp', 'Linked At', 'Sold At', 'Harga Beli', 'Notes', 'Silog', 'Proof', 'Proof GC'
];
// Column index (1-based) untuk rujukan jelas
const COL = {
  EMAIL: 1, PASSWORD: 2, TARIKH: 3, PLAYER: 4, HARGA: 5, SUPPLIER: 6,
  STAGE: 7, WHATSAPP: 8, LINKED_AT: 9, SOLD_AT: 10, HARGA_BELI: 11, NOTES: 12, SILOG: 13,
  PROOF: 14, PROOF_GC: 15
};
const DEFAULT_SILOG = 10; // Konami bagi 10x login/bulan untuk akaun baru

// Pipeline stages (LIMIT = login habis / tunggu reset, side-state non-terminal)
const STAGES      = ['GENERATE', 'CHECKING', 'EDITING', 'LISTED', 'SOLD', 'FLAGGED', 'LIMIT'];
const STAGE_ORDER = ['GENERATE', 'CHECKING', 'EDITING', 'LISTED', 'SOLD']; // FLAGGED & LIMIT luar order
const COMMISSION_LOG_HEADERS = ['Timestamp', 'Email', 'Event', 'Worker', 'Amount'];
const PAYOUT_LOG_HEADERS = ['Timestamp', 'Worker', 'Amount', 'Note'];
const SHORTHAND_SHEET_NAME = 'SHORTHAND_MAP';
const SHORTHAND_HEADERS = ['Kod', 'Nama Penuh'];
const DEFAULT_SHORTHAND = [
  ['NE','NEW EPIC'], ['OE','OLD EPIC'], ['BL','BLUELOCK'], ['TS','TSUBASA'], ['NA','NARUTO'],
  ['S','SHWTIME'], ['B','BIGTIME'], ['E','EPIC'], ['N','NOSTALGIA'], ['P','PACK'], ['M','MANAGER']
];

// Commission rules — ikut OUTCOME (pass vs flag) / sale
const COMMISSION = {
  CHECKING_PASS: { event: 'CHECKING',      worker: 'Dekwan', amount: 1.50 }, // CHECKING -> EDITING
  CHECKING_FLAG: { event: 'CHECKING_FLAG', worker: 'Dekwan', amount: 0.50 }, // CHECKING -> FLAGGED
  EDITING_PASS:  { event: 'EDITING',       worker: 'Korer',  amount: 2.50 }, // EDITING  -> LISTED
  EDITING_FLAG:  { event: 'EDITING_FLAG',  worker: 'Korer',  amount: 0.50 }, // EDITING  -> FLAGGED
  SALE:          { event: 'SALE',          worker: null,     amount: 2.00 }  // LISTED -> SOLD (admin, dynamic)
};
// Untuk guard idempotent stage-level (pass & flag dikira "keluar stage" yang sama)
const STAGE_EVENTS = {
  CHECKING: ['CHECKING', 'CHECKING_FLAG'],
  EDITING:  ['EDITING',  'EDITING_FLAG']
};

// ====== ENTRY POINTS ======
function doGet(e) {
  try {
    const action = ((e && e.parameter && e.parameter.action) || '').toLowerCase();
    if (action === 'dashboard') return jsonOut(handleDashboard());
    if (action === 'inventory') return jsonOut(handleInventory());
    if (action === 'intelligence') return jsonOut(handleIntelligence());
    if (action === 'gaji')      return jsonOut(handleGaji({ period: (e.parameter.period || 'today') }));
    if (action === 'shorthand') return jsonOut(handleShorthandList());
    if (action === 'backupstatus') return jsonOut(handleBackupStatus());
    return jsonOut({ ok: true, data: listAll() });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    const body = parseBody(e);
    const action = (body.action || '').toLowerCase();
    switch (action) {
      case 'generate':    return jsonOut(handleGenerate(body));
      case 'update':      return jsonOut(handleUpdate(body));
      case 'delete':      return jsonOut(handleDelete(body));
      case 'list':        return jsonOut({ ok: true, data: listAll() });
      case 'assignsale':  return jsonOut(handleAssignSale(body));
      case 'uploadproof': return jsonOut(handleUploadProof(body));
      case 'transition':  return jsonOut(handleTransition(body));
      case 'listaccount': return jsonOut(handleListAccount(body));
      case 'dashboard':   return jsonOut(handleDashboard());
      case 'inventory':   return jsonOut(handleInventory());
      case 'intelligence': return jsonOut(handleIntelligence());
      case 'gaji':        return jsonOut(handleGaji(body));
      case 'payout':      return jsonOut(handlePayout(body));
      case 'shorthandlist':   return jsonOut(handleShorthandList());
      case 'shorthandadd':    return jsonOut(handleShorthandAdd(body));
      case 'shorthanddelete': return jsonOut(handleShorthandDelete(body));
      case 'backupnow':       return jsonOut(handleBackupNow());
      case 'backupstatus':    return jsonOut(handleBackupStatus());
      case 'resetdata':       return jsonOut(handleResetData(body));
      default:            return jsonOut({ ok: false, error: 'Unknown action: ' + action });
    }
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

// ====== HANDLERS: CORE ======
function handleGenerate(body) {
  const sheet = getSheet();

  let email = (body.email || '').trim().toLowerCase();
  if (!email) email = generateReadableName() + '@' + EMAIL_DOMAIN;
  if (email.indexOf('@') === -1) email = email + '@' + EMAIL_DOMAIN;

  if (findRowByEmail(sheet, email) !== -1) {
    return { ok: false, error: 'Email dah wujud: ' + email };
  }

  const password   = body.password || FIXED_PASSWORD;
  const tarikh     = formatDate(new Date());
  const playerList = body.playerList || '';
  const harga      = body.harga || '';
  const supplier   = body.supplier || body.seller || ''; // back-compat: terima 'seller'
  const hargaBeli  = body.hargaBeli || '';
  const stage      = (body.stage && STAGES.indexOf(String(body.stage).toUpperCase().trim()) !== -1)
                      ? String(body.stage).toUpperCase().trim()
                      : 'GENERATE'; // default: akaun baru bermula di GENERATE

  sheet.insertRowBefore(2); // newest on top
  // Tulis A-G je (7 col). H/I/J (WhatsApp, Linked At, Sold At) kekal kosong.
  sheet.getRange(2, 1, 1, 7).setValues([[
    email, password, tarikh, playerList, harga, supplier, stage
  ]]);
  if (hargaBeli) sheet.getRange(2, COL.HARGA_BELI).setValue(hargaBeli);
  if (body.notes) sheet.getRange(2, COL.NOTES).setValue(body.notes);
  const silog = (body.silog !== undefined && body.silog !== '') ? body.silog : DEFAULT_SILOG;
  sheet.getRange(2, COL.SILOG).setValue(silog);

  return { ok: true, data: rowToObj(sheet.getRange(2, 1, 1, HEADERS.length).getValues()[0]) };
}

function handleUpdate(body) {
  const sheet = getSheet();
  const email = (body.email || '').trim().toLowerCase();
  if (!email) return { ok: false, error: 'Email required' };

  const row = findRowByEmail(sheet, email);
  if (row === -1) return { ok: false, error: 'Email tak jumpa: ' + email };

  applyEditableFields(sheet, row, body);

  // 'stage' (atau 'status' lama) — raw set, TAKDE auto-komisen (ni manual override)
  const stageInput = (body.stage !== undefined) ? body.stage
                   : (body.status !== undefined) ? body.status : undefined;
  if (stageInput !== undefined) {
    const st = String(stageInput).toUpperCase();
    if (STAGES.indexOf(st) === -1) return { ok: false, error: 'Stage tak valid: ' + st };
    sheet.getRange(row, COL.STAGE).setValue(st);
  }
  return { ok: true, data: rowToObj(sheet.getRange(row, 1, 1, HEADERS.length).getValues()[0]) };
}

/**
 * applyEditableFields — tulis field yang boleh diedit (supplier, harga, harga beli,
 * player list, notes, silog) kalau ada dalam body. Dikongsi oleh update/transition/sale
 * supaya butang advance auto-simpan field sebelum tukar stage.
 */
function applyEditableFields(sheet, row, body) {
  if (body.playerList !== undefined) sheet.getRange(row, COL.PLAYER).setValue(body.playerList);
  if (body.harga      !== undefined) sheet.getRange(row, COL.HARGA).setValue(body.harga);
  if (body.hargaBeli  !== undefined) sheet.getRange(row, COL.HARGA_BELI).setValue(body.hargaBeli);
  if (body.notes      !== undefined) sheet.getRange(row, COL.NOTES).setValue(body.notes);
  if (body.silog      !== undefined) sheet.getRange(row, COL.SILOG).setValue(body.silog);
  if (body.supplier   !== undefined) sheet.getRange(row, COL.SUPPLIER).setValue(body.supplier);
  if (body.seller     !== undefined) sheet.getRange(row, COL.SUPPLIER).setValue(body.seller); // back-compat
}

function handleDelete(body) {
  const sheet = getSheet();
  const email = (body.email || '').trim().toLowerCase();
  if (!email) return { ok: false, error: 'Email required' };

  const row = findRowByEmail(sheet, email);
  if (row === -1) return { ok: false, error: 'Email tak jumpa: ' + email };

  sheet.deleteRow(row);
  return { ok: true, data: { email, deleted: true } };
}

// ====== HANDLERS: PHASE 3 PIPELINE ======

/**
 * transition — majukan akaun ke stage seterusnya (atau FLAGGED) + auto-log komisen.
 * body: { email, toStage? }
 *   - toStage kosong    -> auto next ikut STAGE_ORDER (tak boleh ke SOLD; guna Sale Confirmed)
 *   - toStage='FLAGGED' -> hanya dari CHECKING/EDITING
 * Komisen ikut stage DITINGGALKAN + outcome (pass/flag). Idempotent stage-level.
 */
function handleTransition(body) {
  const sheet = getSheet();
  const email = (body.email || '').trim().toLowerCase();
  if (!email) return { ok: false, error: 'Email required' };

  const row = findRowByEmail(sheet, email);
  if (row === -1) return { ok: false, error: 'Email tak jumpa: ' + email };

  // Auto-save field yang diedit (supplier/harga/harga beli/player/notes/silog) dulu
  applyEditableFields(sheet, row, body);

  const current = String(sheet.getRange(row, COL.STAGE).getValue()).toUpperCase().trim();
  if (current === 'SOLD' || current === 'FLAGGED') {
    return { ok: false, error: 'Akaun di stage terminal (' + current + '), tak boleh advance.' };
  }

  // Tentukan target
  let target;
  const req = (body.toStage ? String(body.toStage).toUpperCase().trim() : '');
  if (req === 'LIMIT') {
    // Park akaun (login habis) — dari mana-mana stage aktif
    if (['GENERATE', 'CHECKING', 'EDITING', 'LISTED'].indexOf(current) === -1) {
      return { ok: false, error: 'Login Habis hanya dari stage aktif (sekarang ' + current + ').' };
    }
    target = 'LIMIT';
  } else if (current === 'LIMIT') {
    // Reactivate lepas reset — hanya masuk semula ke CHECKING
    if (req && req !== 'CHECKING') {
      return { ok: false, error: 'Dari Login Habis hanya boleh masuk semula ke Checking.' };
    }
    target = 'CHECKING';
  } else if (req === 'FLAGGED') {
    if (current !== 'CHECKING' && current !== 'EDITING') {
      return { ok: false, error: 'FLAGGED hanya boleh dari CHECKING/EDITING (sekarang ' + current + ').' };
    }
    target = 'FLAGGED';
  } else {
    const nx = nextStage(current);
    if (!nx || nx === 'SOLD') {
      return { ok: false, error: 'Tiada auto-next dari ' + current + '. (Untuk SOLD guna Sale Confirmed.)' };
    }
    if (req && req !== nx) {
      return { ok: false, error: 'Transition tak valid: ' + current + ' -> ' + req + ' (hanya -> ' + nx + ').' };
    }
    target = nx;
  }

  // Set stage
  sheet.getRange(row, COL.STAGE).setValue(target);

  // Auto-log komisen ikut stage DITINGGALKAN + outcome.
  // Park ke LIMIT = TAKDE komisen (tak boleh login, kerja tak siap).
  let commission = null;
  if (current === 'CHECKING' && target !== 'LIMIT') {
    if (!hasAnyCommission(email, STAGE_EVENTS.CHECKING)) {
      const rule = (target === 'FLAGGED') ? COMMISSION.CHECKING_FLAG : COMMISSION.CHECKING_PASS;
      commission = logCommission(email, rule.event, rule.worker, rule.amount);
    } else {
      commission = { logged: false, reason: 'checking_already_paid' };
    }
  } else if (current === 'EDITING' && target !== 'LIMIT') {
    if (!hasAnyCommission(email, STAGE_EVENTS.EDITING)) {
      const rule = (target === 'FLAGGED') ? COMMISSION.EDITING_FLAG : COMMISSION.EDITING_PASS;
      commission = logCommission(email, rule.event, rule.worker, rule.amount);
    } else {
      commission = { logged: false, reason: 'editing_already_paid' };
    }
  }

  return {
    ok: true,
    data: {
      email: email,
      from: current,
      to: target,
      commission: commission, // { logged, worker, event, amount } atau null
      row: rowToObj(sheet.getRange(row, 1, 1, HEADERS.length).getValues()[0])
    }
  };
}

/**
 * listAccount — admin letak harga + tandakan LISTED. TAKDE komisen (admin dibayar
 * masa SALE, bukan masa list).
 * body: { email, harga }
 * Safety: kalau list terus dari EDITING (Korer tak tekan butang), auto-log
 * Korer (pass RM2.50) sekali (idempotent) supaya Korer tak terlepas.
 */
function handleListAccount(body) {
  const sheet = getSheet();
  const email = (body.email || '').trim().toLowerCase();
  const harga = (body.harga !== undefined) ? String(body.harga).trim() : '';

  if (!email) return { ok: false, error: 'Email required' };
  if (!harga)  return { ok: false, error: 'Harga required' };

  const row = findRowByEmail(sheet, email);
  if (row === -1) return { ok: false, error: 'Email tak jumpa: ' + email };

  const prev = String(sheet.getRange(row, COL.STAGE).getValue()).toUpperCase().trim();
  if (prev === 'SOLD' || prev === 'FLAGGED') {
    return { ok: false, error: 'Akaun di stage terminal (' + prev + '), tak boleh list.' };
  }

  // Safety: list terus dari EDITING -> pastikan Korer dibayar (pass, idempotent)
  let editingCommission = null;
  if (prev === 'EDITING' && !hasAnyCommission(email, STAGE_EVENTS.EDITING)) {
    editingCommission = logCommission(
      email, COMMISSION.EDITING_PASS.event, COMMISSION.EDITING_PASS.worker, COMMISSION.EDITING_PASS.amount
    );
  }

  // Set harga + stage LISTED (TAKDE komisen listing)
  sheet.getRange(row, COL.HARGA).setValue(harga);
  sheet.getRange(row, COL.STAGE).setValue('LISTED');

  return {
    ok: true,
    data: {
      email: email,
      harga: harga,
      stage: 'LISTED',
      editingCommission: editingCommission, // null kalau Korer dah dibayar sebelum ni
      row: rowToObj(sheet.getRange(row, 1, 1, HEADERS.length).getValues()[0])
    }
  };
}

/**
 * Phase 2C — "Sale Confirmed" (KEKAL) + Sold At + komisen SALE (admin RM2.00).
 * body: { email, whatsapp, worker }   worker = nama admin yang serah (Danial/Dekwan)
 */
function handleAssignSale(body) {
  const sheet = getSheet();
  const email = (body.email || '').trim().toLowerCase();
  const whatsappInput = (body.whatsapp || '').trim();
  const worker = (body.worker || 'Admin').trim();

  if (!email)         return { ok: false, error: 'Email required' };
  if (!whatsappInput) return { ok: false, error: 'WhatsApp number required' };

  const row = findRowByEmail(sheet, email);
  if (row === -1) return { ok: false, error: 'Email tak jumpa dalam Sheet: ' + email };

  // Auto-save field yang diedit (cth harga jual) dulu sebelum proses sale
  applyEditableFields(sheet, row, body);

  // --- Call oneestore-link-worker ---
  let workerResult;
  try {
    const resp = UrlFetchApp.fetch(LINK_WORKER_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-link-secret': LINK_SECRET },
      payload: JSON.stringify({ email: email, whatsapp: whatsappInput }),
      muteHttpExceptions: true
    });
    workerResult = JSON.parse(resp.getContentText());
  } catch (err) {
    return { ok: false, error: 'Gagal hubungi link-worker: ' + String(err) };
  }

  if (!workerResult || workerResult.ok !== true) {
    const reason = (workerResult && workerResult.error) ? workerResult.error : 'unknown_error';
    return { ok: false, error: 'link-worker error: ' + reason };
  }

  const normalizedWhatsapp = workerResult.whatsapp; // 60XXXXXXXXX dari worker
  const linkedAt = formatDate(new Date());
  const soldAt = new Date();

  sheet.getRange(row, COL.WHATSAPP).setValue(normalizedWhatsapp);  // H
  sheet.getRange(row, COL.LINKED_AT).setValue(linkedAt);           // I
  sheet.getRange(row, COL.STAGE).setValue('SOLD');                 // G
  sheet.getRange(row, COL.SOLD_AT).setValue(soldAt);              // J (Date)
  sheet.getRange(row, COL.SOLD_AT).setNumberFormat('dd/MM/yyyy HH:mm:ss');

  // Komisen SALE (admin) — worker dynamic, idempotent (email,'SALE')
  const saleCommission = logCommission(email, COMMISSION.SALE.event, worker, COMMISSION.SALE.amount);

  return {
    ok: true,
    data: {
      email: email,
      whatsapp: normalizedWhatsapp,
      linkedAt: linkedAt,
      stage: 'SOLD',
      soldAt: formatDate(soldAt),
      saleCommission: saleCommission // { logged, worker, event, amount }
    }
  };
}

/* ════════ PROOF IMAGE (SS link Konami ID dari game) ════════ */

/**
 * uploadProof — terima gambar (base64) dari app, simpan ke Drive folder
 * "Oneestore Proofs", set sharing anyone-with-link (worker boleh view/download),
 * dan tulis link ke kolum Proof (N) atau Proof GC (O) ikut slot.
 * Upload baru GANTIKAN yang lama (lama di-trash).
 * body: { email, imageBase64, mimeType?, slot? }
 *   slot: 'play' (default, Google Play — Checking) | 'gc' (Game Center — Editing)
 */
function handleUploadProof(body) {
  const sheet = getSheet();
  const email = (body.email || '').trim().toLowerCase();
  if (!email) return { ok: false, error: 'Email required' };
  const b64 = String(body.imageBase64 || '');
  if (!b64)   return { ok: false, error: 'Gambar kosong' };

  const row = findRowByEmail(sheet, email);
  if (row === -1) return { ok: false, error: 'Email tak jumpa: ' + email };

  const slot = (String(body.slot || 'play').toLowerCase() === 'gc') ? 'gc' : 'play';
  const col  = (slot === 'gc') ? COL.PROOF_GC : COL.PROOF;

  // Pastikan header kolum wujud (sheet lama cuma A..M)
  if (String(sheet.getRange(1, col).getValue()).trim() === '') {
    sheet.getRange(1, col).setValue(slot === 'gc' ? 'Proof GC' : 'Proof');
  }

  let bytes;
  try { bytes = Utilities.base64Decode(b64); }
  catch (e) { return { ok: false, error: 'Base64 tak valid' }; }

  const mime  = body.mimeType || 'image/jpeg';
  const ext   = (mime.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
  const stamp = Utilities.formatDate(new Date(), TIMEZONE, 'yyyyMMdd_HHmmss');
  const name  = 'proof_' + slot + '_' + email.split('@')[0] + '_' + stamp + '.' + ext;

  const file = getProofFolder_().createFile(Utilities.newBlob(bytes, mime, name));
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  // Trash proof lama slot ni kalau ada (elak sampah Drive)
  const prevId = extractDriveId_(sheet.getRange(row, col).getValue());
  if (prevId) { try { DriveApp.getFileById(prevId).setTrashed(true); } catch (e) {} }

  const url = 'https://drive.google.com/file/d/' + file.getId() + '/view';
  sheet.getRange(row, col).setValue(url);

  return { ok: true, data: { email: email, slot: slot, proof: url, id: file.getId() } };
}

function getProofFolder_() {
  const it = DriveApp.getFoldersByName(PROOF_FOLDER_NAME);
  while (it.hasNext()) {
    const f = it.next();
    if (f.getName() === PROOF_FOLDER_NAME) return f;
  }
  return DriveApp.createFolder(PROOF_FOLDER_NAME);
}

/** Extract Drive file ID dari URL/string (null kalau takde). */
function extractDriveId_(s) {
  const m = String(s || '').match(/[-\w]{25,}/);
  return m ? m[0] : null;
}

// ====== HANDLERS: DASHBOARD & GAJI ======

/**
 * dashboard — aggregate pipeline counts + sales (today/month) + revenue.
 * Sales/revenue kira ikut Sold At (auto-fill mula Phase 3; SOLD lama tanpa
 * tarikh tak dikira — memang expected).
 */
function handleDashboard() {
  const rows = listAll();
  const pipeline = { GENERATE: 0, CHECKING: 0, EDITING: 0, LISTED: 0, SOLD: 0, FLAGGED: 0, LIMIT: 0 };
  let salesToday = 0, salesMonth = 0, revToday = 0, revMonth = 0, awaitingPrice = 0;
  let profitToday = 0, profitMonth = 0, costMissingToday = 0, costMissingMonth = 0;

  rows.forEach(function (r) {
    const st = String(r.stage || '').toUpperCase().trim();
    if (pipeline[st] !== undefined) pipeline[st]++;

    if (st === 'LISTED' && !String(r.harga).trim()) awaitingPrice++;

    if (st === 'SOLD' && r.soldAt instanceof Date) {
      const jual = parseHarga(r.harga);
      const beli = parseHarga(r.hargaBeli);
      const hasCost = String(r.hargaBeli).trim() !== '';
      if (inPeriod(r.soldAt, 'today')) {
        salesToday++; revToday += jual;
        if (hasCost) profitToday += (jual - beli); else costMissingToday++;
      }
      if (inPeriod(r.soldAt, 'month')) {
        salesMonth++; revMonth += jual;
        if (hasCost) profitMonth += (jual - beli); else costMissingMonth++;
      }
    }
  });

  return {
    ok: true,
    data: {
      pipeline: pipeline,
      readyToSell: pipeline.LISTED,
      awaitingPrice: awaitingPrice,
      sales: { today: salesToday, month: salesMonth },
      revenue: { today: round2(revToday), month: round2(revMonth) },
      profit: { today: round2(profitToday), month: round2(profitMonth) },
      costMissing: { today: costMissingToday, month: costMissingMonth },
      generatedAt: formatDate(new Date())
    }
  };
}

/* ════════ INVENTORY AGING (modal beku + akaun slow-moving) ════════ */

function parseTarikh_(v) {
  if (v instanceof Date) return v;
  const s = String(v || '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function daysSince_(d) {
  if (!d) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

/**
 * inventory — kesihatan stok: modal beku, potensi jualan, aging akaun belum jual.
 * Active inventory = GENERATE/CHECKING/EDITING/LISTED/LIMIT (bukan SOLD, bukan FLAGGED).
 */
function handleInventory() {
  const rows = listAll();
  const ACTIVE = ['GENERATE', 'CHECKING', 'EDITING', 'LISTED', 'LIMIT'];
  let modalBeku = 0, countStok = 0, costMissing = 0;
  let listedCount = 0, potensiJualan = 0, potensiUntung = 0, listedUntungCount = 0;
  let modalFlagged = 0, flaggedCount = 0;
  const buckets = [
    { label: '0–3 hari',  min: 0,  max: 3,         count: 0, modal: 0 },
    { label: '4–7 hari',  min: 4,  max: 7,         count: 0, modal: 0 },
    { label: '8–14 hari', min: 8,  max: 14,        count: 0, modal: 0 },
    { label: '15+ hari',  min: 15, max: 100000000, count: 0, modal: 0 }
  ];
  const items = [];

  rows.forEach(function (r) {
    const st = String(r.stage || '').toUpperCase().trim();
    const beli = parseHarga(r.hargaBeli);
    const jual = parseHarga(r.harga);
    const hasCost = String(r.hargaBeli).trim() !== '';

    if (st === 'FLAGGED') { flaggedCount++; modalFlagged += beli; return; }
    if (ACTIVE.indexOf(st) === -1) return; // SOLD & lain — skip

    countStok++;
    modalBeku += beli;
    if (!hasCost) costMissing++;

    if (st === 'LISTED') {
      listedCount++;
      potensiJualan += jual;
      if (hasCost && jual > 0) { potensiUntung += (jual - beli); listedUntungCount++; }
    }

    const age = daysSince_(parseTarikh_(r.tarikh));
    const ageVal = (age === null) ? 0 : age;
    for (let i = 0; i < buckets.length; i++) {
      if (ageVal >= buckets[i].min && ageVal <= buckets[i].max) {
        buckets[i].count++; buckets[i].modal = round2(buckets[i].modal + beli); break;
      }
    }
    items.push({
      email: r.email,
      stage: st,
      days: age,
      hargaBeli: hasCost ? round2(beli) : null,
      hargaJual: (String(r.harga).trim() !== '') ? round2(jual) : null
    });
  });

  items.sort(function (a, b) { return (b.days || 0) - (a.days || 0); }); // tertua dulu

  return {
    ok: true,
    data: {
      modalBeku: round2(modalBeku),
      countStok: countStok,
      costMissing: costMissing,
      listedCount: listedCount,
      potensiJualan: round2(potensiJualan),
      potensiUntung: round2(potensiUntung),
      listedUntungCount: listedUntungCount,
      modalFlagged: round2(modalFlagged),
      flaggedCount: flaggedCount,
      buckets: buckets.map(function (b) { return { label: b.label, count: b.count, modal: round2(b.modal) }; }),
      items: items,
      generatedAt: formatDate(new Date())
    }
  };
}

/**
 * gaji — aggregate komisen per worker untuk period (today|month|all).
 * body: { period }
 */
function handleGaji(body) {
  const period = ((body && body.period) || 'today').toLowerCase();
  const rows = listCommission(); // [Timestamp(Date), Email, Event, Worker, Amount]

  const totals = {};  // { worker: amount }
  const byEvent = { CHECKING: 0, CHECKING_FLAG: 0, EDITING: 0, EDITING_FLAG: 0, SALE: 0 };
  let grand = 0, count = 0;

  rows.forEach(function (r) {
    const ts = r[0];
    const worker = String(r[3] || '').trim() || 'Unknown';
    const event = String(r[2] || '').toUpperCase().trim();
    const amount = Number(r[4]) || 0;
    if (!inPeriod(ts, period)) return;
    totals[worker] = round2((totals[worker] || 0) + amount);
    if (byEvent[event] !== undefined) byEvent[event] = round2(byEvent[event] + amount);
    grand = round2(grand + amount);
    count++;
  });

  // Settlement (sepanjang masa) — earned vs paid per worker, untuk track baki
  const earnedAll = {};
  rows.forEach(function (r) {
    const w = String(r[3] || '').trim() || 'Unknown';
    earnedAll[w] = round2((earnedAll[w] || 0) + (Number(r[4]) || 0));
  });
  const payRows = listPayout();
  const paidAll = {};
  payRows.forEach(function (r) {
    const w = String(r[1] || '').trim() || 'Unknown';
    paidAll[w] = round2((paidAll[w] || 0) + (Number(r[2]) || 0));
  });
  const allWorkers = {};
  Object.keys(earnedAll).forEach(function (w) { allWorkers[w] = true; });
  Object.keys(paidAll).forEach(function (w) { allWorkers[w] = true; });
  const settlement = Object.keys(allWorkers).map(function (w) {
    const e = earnedAll[w] || 0, p = paidAll[w] || 0;
    return { worker: w, earned: round2(e), paid: round2(p), baki: round2(e - p) };
  }).sort(function (a, b) { return b.baki - a.baki; });

  return {
    ok: true,
    data: {
      period: period,
      totals: totals,        // { Dekwan: x, Korer: y, Danial: z, ... } — period
      byEvent: byEvent,      // { CHECKING, CHECKING_FLAG, EDITING, EDITING_FLAG, SALE } — period
      grandTotal: grand,
      count: count,
      settlement: settlement, // sepanjang masa: { worker, earned, paid, baki }
      generatedAt: formatDate(new Date())
    }
  };
}

/**
 * payout — rekod bayaran gaji kepada pekerja (Cara B: log berasingan).
 * body: { worker, amount, note? }
 * Baki dikira di handleGaji: jumlah earned (COMMISSION_LOG) - jumlah paid (PAYOUT_LOG).
 */
function handlePayout(body) {
  const worker = (body.worker || '').trim();
  const amount = Number(body.amount);
  if (!worker)               return { ok: false, error: 'Worker required' };
  if (!amount || amount <= 0) return { ok: false, error: 'Amount tak valid' };

  const sheet = getPayoutSheet();
  const ts = new Date();
  sheet.appendRow([ts, worker, round2(amount), (body.note || '')]);
  const row = sheet.getLastRow();
  sheet.getRange(row, 1).setNumberFormat('dd/MM/yyyy HH:mm:ss');
  sheet.getRange(row, 3).setNumberFormat('0.00');

  return { ok: true, data: { worker: worker, amount: round2(amount), paidAt: formatDate(ts) } };
}

/* ════════ SHORTHAND MAP (kod collab → nama penuh) ════════ */

/** Senarai semua kod. */
function handleShorthandList() {
  return { ok: true, data: listShorthand() };
}

/**
 * Tambah / kemaskini satu kod.
 * body: { code, name }  — kalau kod dah wujud, overwrite nama.
 */
function handleShorthandAdd(body) {
  const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  const name = String(body.name || '').toUpperCase().trim();
  if (!code) return { ok: false, error: 'Kod tak valid (huruf/nombor je, max 4)' };
  if (!name) return { ok: false, error: 'Nama penuh kosong' };

  const sheet = getShorthandSheet();
  const last = sheet.getLastRow();
  // cari kalau dah wujud → update
  if (last >= 2) {
    const codes = sheet.getRange(2, 1, last - 1, 1).getValues();
    for (let i = 0; i < codes.length; i++) {
      if (String(codes[i][0]).toUpperCase().trim() === code) {
        sheet.getRange(i + 2, 2).setValue(name);
        return { ok: true, data: listShorthand(), updated: true };
      }
    }
  }
  sheet.appendRow([code, name]);
  return { ok: true, data: listShorthand(), added: true };
}

/** Padam satu kod. body: { code } */
function handleShorthandDelete(body) {
  const code = String(body.code || '').toUpperCase().trim();
  if (!code) return { ok: false, error: 'Kod kosong' };
  const sheet = getShorthandSheet();
  const last = sheet.getLastRow();
  if (last >= 2) {
    const codes = sheet.getRange(2, 1, last - 1, 1).getValues();
    for (let i = codes.length - 1; i >= 0; i--) {
      if (String(codes[i][0]).toUpperCase().trim() === code) {
        sheet.deleteRow(i + 2);
        return { ok: true, data: listShorthand(), deleted: true };
      }
    }
  }
  return { ok: false, error: 'Kod tak jumpa: ' + code };
}

function getShorthandSheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName(SHORTHAND_SHEET_NAME);
  let justCreated = false;
  if (!sheet) { sheet = ss.insertSheet(SHORTHAND_SHEET_NAME); justCreated = true; }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, SHORTHAND_HEADERS.length).setValues([SHORTHAND_HEADERS]);
    sheet.setFrozenRows(1);
    justCreated = true;
  }
  // Seed default kalau baru (atau kosong) supaya converter terus ada kod sedia ada
  if (justCreated && sheet.getLastRow() < 2) {
    sheet.getRange(2, 1, DEFAULT_SHORTHAND.length, 2).setValues(DEFAULT_SHORTHAND);
  }
  return sheet;
}

function listShorthand() {
  const sheet = getShorthandSheet();
  const last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, 2).getValues()
    .map(function (r) { return { code: String(r[0]).toUpperCase().trim(), name: String(r[1]).toUpperCase().trim() }; })
    .filter(function (x) { return x.code && x.name; });
}

/* ════════ INTELLIGENCE (margin %, category laku, supplier ROI) ════════ */

/**
 * Extract player categories dari Player List satu akaun.
 * e.g. "NEW EPIC MESSI\nBLUELOCK BACHIE" → ['NEW EPIC','BLUELOCK']
 * Unik per akaun (kalau ada 3 NEW EPIC, kira sekali je untuk "akaun ada category ni").
 */
function extractCategories_(playerList) {
  const cats = {};
  const lines = String(playerList || '').split('\n');
  lines.forEach(function (line) {
    const t = line.trim().toUpperCase();
    if (!t) return;
    // Match known multi-word categories first
    if (t.indexOf('NEW EPIC') === 0)   { cats['NEW EPIC'] = true; return; }
    if (t.indexOf('OLD EPIC') === 0)   { cats['OLD EPIC'] = true; return; }
    if (t.indexOf('BLUELOCK') === 0)   { cats['BLUELOCK'] = true; return; }
    if (t.indexOf('BIGTIME') === 0)    { cats['BIGTIME'] = true; return; }
    if (t.indexOf('SHWTIME') === 0)    { cats['SHWTIME'] = true; return; }
    if (t.indexOf('NOSTALGIA') === 0)  { cats['NOSTALGIA'] = true; return; }
    if (t.indexOf('NARUTO') === 0)     { cats['NARUTO'] = true; return; }
    if (t.indexOf('TSUBASA') === 0)    { cats['TSUBASA'] = true; return; }
    if (t.indexOf('EPIC') === 0)       { cats['EPIC'] = true; return; }
    if (t.indexOf('PACK') === 0)       { cats['PACK'] = true; return; }
    if (t.indexOf('MANAGER') === 0)    { cats['MANAGER'] = true; return; }
    // Fallback: ambil perkataan pertama sebagai category
    const first = t.split(' ')[0];
    if (first && first.length >= 2)    { cats[first] = true; }
  });
  return Object.keys(cats);
}

function handleIntelligence() {
  const rows = listAll();
  const soldRows = rows.filter(function (r) {
    return String(r.stage||'').toUpperCase() === 'SOLD' && r.soldAt instanceof Date;
  });

  if (soldRows.length === 0) {
    return { ok: true, data: { empty: true, soldCount: 0 } };
  }

  // ── Margin per sale
  let totalMarginPct = 0, marginCount = 0, totalProfit = 0, totalRev = 0;
  soldRows.forEach(function (r) {
    const jual = parseHarga(r.harga), beli = parseHarga(r.hargaBeli);
    if (jual > 0) { totalRev += jual; }
    if (jual > 0 && beli > 0) {
      totalProfit += (jual - beli);
      totalMarginPct += ((jual - beli) / jual * 100);
      marginCount++;
    }
  });
  const avgMarginPct = marginCount ? round2(totalMarginPct / marginCount) : null;

  // ── Category breakdown (ikut berapa akaun terjual ada category tu)
  const catSales = {}, catRevenue = {}, catProfit = {}, catCount = {};
  soldRows.forEach(function (r) {
    const cats = extractCategories_(r.playerList);
    const jual = parseHarga(r.harga), beli = parseHarga(r.hargaBeli);
    cats.forEach(function (cat) {
      catCount[cat] = (catCount[cat] || 0) + 1;
      catSales[cat] = round2((catSales[cat] || 0) + jual);
      if (jual > 0 && beli > 0) catProfit[cat] = round2((catProfit[cat] || 0) + (jual - beli));
    });
  });
  const categories = Object.keys(catCount).map(function (cat) {
    return {
      cat: cat,
      count: catCount[cat],
      revenue: catSales[cat] || 0,
      profit: catProfit[cat] || 0
    };
  }).sort(function (a, b) { return b.count - a.count; }).slice(0, 8);

  // ── Supplier ROI
  const supSales = {}, supRevenue = {}, supProfit = {}, supBeli = {}, supCount = {};
  soldRows.forEach(function (r) {
    const sup = String(r.supplier || '').trim() || '(tiada)';
    const jual = parseHarga(r.harga), beli = parseHarga(r.hargaBeli);
    supCount[sup] = (supCount[sup] || 0) + 1;
    supRevenue[sup] = round2((supRevenue[sup] || 0) + jual);
    supBeli[sup] = round2((supBeli[sup] || 0) + beli);
    if (jual > 0 && beli > 0) supProfit[sup] = round2((supProfit[sup] || 0) + (jual - beli));
  });
  const suppliers = Object.keys(supCount).map(function (sup) {
    const rev = supRevenue[sup] || 0, beli = supBeli[sup] || 0, profit = supProfit[sup] || 0;
    const roi = (beli > 0) ? round2(profit / beli * 100) : null;
    return { sup: sup, count: supCount[sup], revenue: rev, profit: profit, modal: beli, roi: roi };
  }).sort(function (a, b) { return (b.roi||0) - (a.roi||0) || b.count - a.count; }).slice(0, 8);

  // ── Sales by Admin (siapa serah — dari COMMISSION_LOG event SALE, join dgn harga akaun)
  const acctByEmail = {};
  rows.forEach(function (r) {
    const em = String(r.email || '').trim().toLowerCase();
    if (em) acctByEmail[em] = { jual: parseHarga(r.harga), beli: parseHarga(r.hargaBeli) };
  });
  const admSales = {}, admRev = {}, admProfit = {};
  listCommission().forEach(function (c) {
    if (String(c[2] || '').toUpperCase().trim() !== 'SALE') return;
    const worker = String(c[3] || '').trim() || '(tiada)';
    const em = String(c[1] || '').trim().toLowerCase();
    const acct = acctByEmail[em];
    admSales[worker] = (admSales[worker] || 0) + 1;
    if (acct) {
      admRev[worker] = round2((admRev[worker] || 0) + acct.jual);
      if (acct.jual > 0 && acct.beli > 0) admProfit[worker] = round2((admProfit[worker] || 0) + (acct.jual - acct.beli));
    }
  });
  const admins = Object.keys(admSales).map(function (w) {
    return { worker: w, sales: admSales[w], revenue: admRev[w] || 0, profit: admProfit[w] || 0 };
  }).sort(function (a, b) { return b.sales - a.sales; });

  return {
    ok: true,
    data: {
      empty: false,
      soldCount: soldRows.length,
      avgMarginPct: avgMarginPct,
      totalProfit: round2(totalProfit),
      totalRev: round2(totalRev),
      marginCount: marginCount,
      categories: categories,
      suppliers: suppliers,
      admins: admins,
      generatedAt: formatDate(new Date())
    }
  };
}

/**
 * Salin SELURUH fail spreadsheet (semua tab: GMAIL_DATA, COMMISSION_LOG,
 * PAYOUT_LOG, SHORTHAND_MAP) ke folder "Oneestore Backups" dalam Drive.
 * Auto-buang backup lama (simpan BACKUP_KEEP terkini je).
 * Boleh dipanggil oleh trigger harian ATAU butang dalam app.
 */
function backupNow() {
  const src = DriveApp.getFileById(SHEET_ID);
  const folder = getBackupFolder_();
  const stamp = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd_HHmm');
  const name = 'Oneestore Backup ' + stamp;
  const copy = src.makeCopy(name, folder);
  pruneBackups_(folder);
  return { name: name, id: copy.getId(), at: formatDate(new Date()) };
}

function getBackupFolder_() {
  const it = DriveApp.getFoldersByName(BACKUP_FOLDER_NAME);
  while (it.hasNext()) {
    const f = it.next();
    if (f.getName() === BACKUP_FOLDER_NAME) return f;
  }
  return DriveApp.createFolder(BACKUP_FOLDER_NAME);
}

function pruneBackups_(folder) {
  const files = [];
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (f.getName().indexOf('Oneestore Backup ') === 0) {
      files.push({ file: f, date: f.getDateCreated().getTime() });
    }
  }
  files.sort(function (a, b) { return b.date - a.date; }); // terbaru dulu
  for (let i = BACKUP_KEEP; i < files.length; i++) {
    files[i].file.setTrashed(true);
  }
}

/**
 * RUN SEKALI dari editor untuk pasang backup harian automatik (3 pagi).
 * Ini juga akan trigger authorization Drive (klik Allow bila diminta).
 */
function setupBackupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'backupNow') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('backupNow')
    .timeBased()
    .everyDays(1)
    .atHour(3)            // 3 pagi waktu Malaysia
    .inTimezone(TIMEZONE)
    .create();
  const first = backupNow(); // buat satu backup terus sebagai ujian
  Logger.log('✅ Trigger backup harian (3 pagi) dah dipasang.');
  Logger.log('✅ Backup pertama siap: ' + first.name);
  return first;
}

/** Status backup terkini (untuk app). */
function handleBackupStatus() {
  const folder = getBackupFolder_();
  const files = [];
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (f.getName().indexOf('Oneestore Backup ') === 0) {
      files.push({ name: f.getName(), date: f.getDateCreated() });
    }
  }
  files.sort(function (a, b) { return b.date - a.date; });
  const latest = files.length ? { name: files[0].name, at: formatDate(files[0].date) } : null;
  return { ok: true, data: { count: files.length, latest: latest, keep: BACKUP_KEEP } };
}

/** Backup manual dari app. */
function handleBackupNow() {
  const r = backupNow();
  return { ok: true, data: r };
}

/* ════════ RESET DATA (padam semua akaun + komisen + payout) ════════ */
/**
 * BAHAYA: kosongkan GMAIL_DATA, COMMISSION_LOG, PAYOUT_LOG (kekalkan header).
 * SHORTHAND_MAP TIDAK disentuh. Auto-backup dulu sebagai safety net.
 * Perlu body.confirm === 'PADAM' — elak trigger tak sengaja.
 */
function handleResetData(body) {
  if (String((body && body.pin) || '') !== RESET_PIN) {
    return { ok: false, error: 'PIN salah' };
  }
  // Safety net: backup penuh dulu sebelum padam apa-apa
  let backupName = null;
  try { backupName = backupNow().name; } catch (e) { backupName = null; }

  const cleared = {
    accounts:   clearSheetData_(getSheet()),
    commission: clearSheetData_(getCommissionSheet()),
    payout:     clearSheetData_(getPayoutSheet())
  };
  // SHORTHAND_MAP sengaja TIDAK dipadam (senarai kod converter)

  return { ok: true, data: { cleared: cleared, backup: backupName } };
}

/** Kosongkan content row 2 ke bawah (kekalkan header + validation). Return bilangan row dikosongkan. */
function clearSheetData_(sheet) {
  const last = sheet.getLastRow();
  const cols = sheet.getLastColumn();
  if (last < 2 || cols < 1) return 0;
  const n = last - 1;
  sheet.getRange(2, 1, n, cols).clearContent();
  return n;
}

// ====== HELPERS: SHEET ======
function getSheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  // Safety: sheet lama mungkin fizikal < 14 kolum — tambah supaya baca kolum Proof tak error
  if (sheet.getMaxColumns() < HEADERS.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), HEADERS.length - sheet.getMaxColumns());
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function getCommissionSheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName(COMMISSION_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(COMMISSION_SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, COMMISSION_LOG_HEADERS.length).setValues([COMMISSION_LOG_HEADERS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function getPayoutSheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName(PAYOUT_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(PAYOUT_SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, PAYOUT_LOG_HEADERS.length).setValues([PAYOUT_LOG_HEADERS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function listAll() {
  const sheet = getSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues().map(rowToObj);
}

function listCommission() {
  const sheet = getCommissionSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, COMMISSION_LOG_HEADERS.length).getValues();
}

function listPayout() {
  const sheet = getPayoutSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, PAYOUT_LOG_HEADERS.length).getValues();
}

function rowToObj(r) {
  const stage = r[6];
  const supplier = r[5];
  return {
    email: r[0], password: r[1], tarikh: r[2], playerList: r[3],
    harga: r[4], hargaBeli: r[10] || '', notes: r[11] || '', silog: (r[12] === '' || r[12] === null || r[12] === undefined) ? '' : r[12],
    supplier: supplier, seller: supplier,   // 'seller' alias (back-compat frontend lama)
    stage: stage, status: stage,            // 'status' alias (back-compat frontend lama)
    whatsapp: r[7] || '', linkedAt: r[8] || '',
    soldAt: (r[9] instanceof Date) ? r[9] : (r[9] || ''),
    proof: r[13] || '', proofGc: r[14] || ''
  };
}

function findRowByEmail(sheet, email) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const emails = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < emails.length; i++) {
    if (String(emails[i][0]).trim().toLowerCase() === email) return i + 2;
  }
  return -1;
}

// ====== HELPERS: COMMISSION ======
/**
 * logCommission — append satu row komisen. Idempotent ikut (email,event):
 * kalau dah ada, TAK append lagi (elak double-pay).
 * return { logged: bool, worker, event, amount }
 */
function logCommission(email, event, worker, amount) {
  if (hasCommission(email, event)) {
    return { logged: false, worker: worker, event: event, amount: amount, reason: 'already_logged' };
  }
  const sheet = getCommissionSheet();
  const ts = new Date();
  sheet.appendRow([ts, email, event, worker, amount]);
  const row = sheet.getLastRow();
  sheet.getRange(row, 1).setNumberFormat('dd/MM/yyyy HH:mm:ss');
  sheet.getRange(row, 5).setNumberFormat('0.00');
  return { logged: true, worker: worker, event: event, amount: amount };
}

function hasCommission(email, event) {
  const rows = listCommission();
  const e = String(email).trim().toLowerCase();
  const ev = String(event).toUpperCase().trim();
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][1]).trim().toLowerCase() === e &&
        String(rows[i][2]).toUpperCase().trim() === ev) return true;
  }
  return false;
}

function hasAnyCommission(email, events) {
  for (let i = 0; i < events.length; i++) {
    if (hasCommission(email, events[i])) return true;
  }
  return false;
}

// ====== HELPERS: UTIL ======
function nextStage(from) {
  const i = STAGE_ORDER.indexOf(String(from).toUpperCase().trim());
  if (i === -1 || i >= STAGE_ORDER.length - 1) return null;
  return STAGE_ORDER[i + 1];
}

function parseHarga(h) {
  if (typeof h === 'number') return h;
  const cleaned = String(h).replace(/[^0-9.]/g, '');
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function dateKeyOf(d, kind) { // kind: 'day' | 'month'
  if (!(d instanceof Date)) return '';
  return Utilities.formatDate(d, TIMEZONE, kind === 'month' ? 'yyyy-MM' : 'yyyy-MM-dd');
}

function inPeriod(d, period) {
  if (period === 'all') return true;
  if (!(d instanceof Date)) return false;
  if (period === 'today') return dateKeyOf(d, 'day')   === dateKeyOf(new Date(), 'day');
  if (period === 'month') return dateKeyOf(d, 'month') === dateKeyOf(new Date(), 'month');
  return false;
}

function parseBody(e) {
  if (e && e.postData && e.postData.contents) {
    try { return JSON.parse(e.postData.contents); } catch (err) {}
  }
  return (e && e.parameter) ? e.parameter : {};
}

function formatDate(d) {
  return Utilities.formatDate(d, TIMEZONE, 'dd/MM/yyyy HH:mm:ss');
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ====== RANDOM NAME GENERATOR (safety net) ======
function generateReadableName() {
  const c = 'bcdfghjklmnpqrstvwxyz', v = 'aeiou';
  let name = '';
  for (let i = 0; i < 3; i++) {
    name += c.charAt(Math.floor(Math.random() * c.length));
    name += v.charAt(Math.floor(Math.random() * v.length));
  }
  const num = Math.floor(Math.random() * 90) + 10; // 10-99
  return name + num + 'EF';
}

function testAuth() {
  UrlFetchApp.fetch('https://example.com');
}

// ====== SELF TEST (run dari editor untuk validate chain — auto cleanup) ======
// NOTE: SALE commission (LISTED->SOLD) sebenar lalu assignSale yang panggil
// live D1 link-worker. Untuk elak side-effect ke D1, selfTest SIMULASI komisen
// SALE secara terus (logCommission) je. Butang "Sale Confirmed" sebenar diuji live.
function selfTest() {
  const d1 = '__selftest1__@onee.store'; // pass penuh + list + (simulasi) sale
  const d2 = '__selftest2__@onee.store'; // flag kat CHECKING
  const d3 = '__selftest3__@onee.store'; // flag kat EDITING
  const d4 = '__selftest4__@onee.store'; // LIMIT round-trip
  [d1, d2, d3, d4].forEach(_selfCleanup);

  const out = {};

  // d1: GENERATE -> CHECKING -> EDITING -> LISTED -> (simulasi) SOLD
  out.d1_gen  = handleGenerate({ email: d1, harga: '', supplier: 'Test' });
  out.d1_t1   = handleTransition({ email: d1 });                 // -> CHECKING (no komisen)
  out.d1_t2   = handleTransition({ email: d1 });                 // -> EDITING  (Dekwan 1.50)
  out.d1_t3   = handleTransition({ email: d1 });                 // -> LISTED   (Korer 2.50)
  out.d1_list = handleListAccount({ email: d1, harga: '99' });   // set harga (NO komisen)
  out.d1_sale = logCommission(d1, COMMISSION.SALE.event, 'Danial', COMMISSION.SALE.amount); // simulasi SALE admin 2.00

  // d2: GENERATE -> CHECKING -> FLAGGED  (Dekwan 0.50)
  out.d2_gen  = handleGenerate({ email: d2, supplier: 'Test' });
  out.d2_t1   = handleTransition({ email: d2 });                 // -> CHECKING
  out.d2_flag = handleTransition({ email: d2, toStage: 'FLAGGED' }); // Dekwan 0.50

  // d3: GENERATE -> CHECKING -> EDITING -> FLAGGED  (Dekwan 1.50 + Korer 0.50)
  out.d3_gen  = handleGenerate({ email: d3, supplier: 'Test' });
  out.d3_t1   = handleTransition({ email: d3 });                 // -> CHECKING
  out.d3_t2   = handleTransition({ email: d3 });                 // -> EDITING (Dekwan 1.50)
  out.d3_flag = handleTransition({ email: d3, toStage: 'FLAGGED' }); // Korer 0.50

  // d4: LIMIT round-trip — GENERATE -> LIMIT -> CHECKING -> LIMIT -> CHECKING -> EDITING
  //     park/reactivate TAKDE komisen; akhirnya pass = Dekwan 1.50 (sekali je)
  out.d4_gen   = handleGenerate({ email: d4, supplier: 'Test' });
  out.d4_park1 = handleTransition({ email: d4, toStage: 'LIMIT' });    // GENERATE -> LIMIT (no komisen)
  out.d4_back1 = handleTransition({ email: d4, toStage: 'CHECKING' }); // LIMIT -> CHECKING (no komisen)
  out.d4_park2 = handleTransition({ email: d4, toStage: 'LIMIT' });    // CHECKING -> LIMIT (no komisen)
  out.d4_back2 = handleTransition({ email: d4, toStage: 'CHECKING' }); // LIMIT -> CHECKING (no komisen)
  out.d4_pass  = handleTransition({ email: d4 });                      // CHECKING -> EDITING (Dekwan 1.50)

  out.gaji = handleGaji({ period: 'all' });

  Logger.log(JSON.stringify(out, null, 2));
  Logger.log('--- Expected totals (all): Dekwan 5.00, Korer 3.00, Danial 2.00 ---');
  Logger.log('    Dekwan = 1.50+0.50+1.50+1.50 | Korer = 2.50+0.50 | Danial = 2.00(SALE)');

  [d1, d2, d3, d4].forEach(_selfCleanup);
  Logger.log('cleanup done (semua dummy dipadam)');
  return out;
}

function _selfCleanup(email) {
  const sheet = getSheet();
  const row = findRowByEmail(sheet, email);
  if (row !== -1) sheet.deleteRow(row);
  _deleteCommissionByEmail(email);
}

function _deleteCommissionByEmail(email) {
  const sheet = getCommissionSheet();
  const last = sheet.getLastRow();
  if (last < 2) return;
  const vals = sheet.getRange(2, 1, last - 1, COMMISSION_LOG_HEADERS.length).getValues();
  const e = String(email).trim().toLowerCase();
  for (let i = vals.length - 1; i >= 0; i--) {
    if (String(vals[i][1]).trim().toLowerCase() === e) sheet.deleteRow(i + 2);
  }
}
