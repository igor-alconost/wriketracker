/**
 * Alconost Brief Tracker → Google Sheets connector (Google Apps Script web app).
 *
 * ONE-TIME SETUP
 *  1. Go to https://script.google.com  →  New project.
 *  2. Delete the sample code, paste THIS whole file, Save.
 *  3. Deploy ▸ New deployment ▸ type "Web app".
 *       - Description: brief-tracker
 *       - Execute as:  Me
 *       - Who has access:  Anyone
 *     Deploy, authorize when prompted, and COPY the "Web app URL"
 *     (looks like https://script.google.com/macros/s/AKfy.../exec).
 *  4. Paste that URL into the dashboard the first time you click "→ Sheet".
 *
 * It writes to the tab named after the card ticket (e.g. PF-65623), filling
 * Project name / Languages codes / Original content and the language column
 * headers. It only touches columns A–E + the header row, so translations you
 * add later in the language columns are never overwritten.
 */

// The two spreadsheets, keyed by ticket prefix (IP).
var SHEETS = {
  MPY: '1YMqUI3ZUIMK4W0gpSvnBOTkCyxE4W3lnul80bx_FFss', // MPY-Linguini and Farming translations batches
  PF:  '1D-OdC4TeqX-nECnwAgYv_RlrCXtX2euayuPrJzmbYog'  // Pixel Flow translations
};

function doPost(e) {
  try {
    var p = JSON.parse(e.postData.contents);

    // Create an LQA Report spreadsheet in a Drive folder (a NEW file — no source spreadsheet needed).
    // Optionally check whether we can access the review-assets link. Needs Drive permission.
    if (p.mode === 'lqaReport') {
      var accessible = null;
      if (p.assetsUrl) {
        var ma = String(p.assetsUrl).match(/[-\w]{25,}/); var idA = ma ? ma[0] : '';
        if (idA) { accessible = false; try { DriveApp.getFolderById(idA); accessible = true; } catch (eF) { try { DriveApp.getFileById(idA); accessible = true; } catch (eG) { accessible = false; } } }
      }
      var newSs = SpreadsheetApp.create(String(p.name || 'LQA Report'));
      var langsL = (p.langs && p.langs.length) ? p.langs : ['—'];
      var HEAD = ['File name', 'Current content', 'Fixed content', 'Comment / Screenshot'];
      langsL.forEach(function (lc, idx) {
        var sh = (idx === 0) ? newSs.getSheets()[0] : newSs.insertSheet();
        sh.setName(String(lc).slice(0, 90).replace(/[:\\\/?*\[\]]/g, '-'));
        var hr = sh.getRange(1, 1, 1, HEAD.length);
        hr.setValues([HEAD]).setBackground('#4285f4').setFontColor('#ffffff').setFontWeight('bold');
        sh.setFrozenRows(1);
        sh.setColumnWidth(1, 200); sh.setColumnWidth(2, 260); sh.setColumnWidth(3, 260); sh.setColumnWidth(4, 320);
      });
      var fileL = DriveApp.getFileById(newSs.getId());
      var moved = false, shared = false, note = '';
      try { fileL.moveTo(DriveApp.getFolderById(String(p.parentFolderId))); moved = true; }   // moveTo handles Shared Drives
      catch (eMove) { note = 'move: ' + eMove; }
      try { fileL.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.EDIT); shared = true; }
      catch (eShare) { note = (note ? note + ' | ' : '') + 'share: ' + eShare; }
      return _json({ ok: true, mode: 'lqaReport', url: newSs.getUrl(), id: newSs.getId(), accessible: accessible, moved: moved, shared: shared, note: note });
    }

    // Just create (or find) the <ticket> subfolder and return its link — used when an attachment is
    // too big to relay through here. Needs no spreadsheet, so it sits before the ssId guard below.
    if (p.mode === 'ensureFolder') {
      var eParent = DriveApp.getFolderById(String(p.parentFolderId));
      var eName = String(p.ticket || 'misc');
      var eit = eParent.getFoldersByName(eName);
      var eSub = eit.hasNext() ? eit.next() : eParent.createFolder(eName);
      return _json({ ok: true, mode: 'ensureFolder', folderId: eSub.getId(), url: eSub.getUrl() });
    }

    // Prefer an explicit spreadsheet id chosen in the dashboard; fall back to the ticket-prefix map.
    var ssId = p.spreadsheetId || SHEETS[p.ip];
    if (!ssId) return _json({ ok: false, error: 'No spreadsheet chosen (and none mapped for "' + p.ip + '")' });

    // List the tab (sheet) names in a spreadsheet — used to detect which cards already have a tab.
    if (p.mode === 'listTabs') {
      var lss = SpreadsheetApp.openById(ssId);
      return _json({ ok: true, tabs: lss.getSheets().map(function (s) { return s.getName(); }) });
    }

    // Read the "Original content" column (the source strings) from a tab — the source of truth
    // for → Crowdin, so lines added by hand in the sheet are picked up.
    if (p.mode === 'readSource') {
      var rss = SpreadsheetApp.openById(ssId);
      var rsheet = rss.getSheetByName(String(p.tab));
      if (!rsheet) return _json({ ok: false, error: 'tab not found: ' + p.tab });
      var rLastCol = rsheet.getLastColumn(), rLastRow = rsheet.getLastRow();
      if (rLastRow < 2 || rLastCol < 1) return _json({ ok: true, strings: [] });
      var rHead = rsheet.getRange(1, 1, 1, rLastCol).getValues()[0];
      var srcCol = 0, rCtxCol = 0;
      for (var si = 0; si < rHead.length; si++) { var hn = String(rHead[si]).trim().toLowerCase(); if (hn === 'original content') srcCol = si + 1; if (hn === 'context') rCtxCol = si + 1; }
      if (!srcCol) return _json({ ok: false, error: 'no "Original content" column in ' + p.tab });
      var col = rsheet.getRange(2, srcCol, rLastRow - 1, 1).getValues().map(function (r) { return String(r[0] == null ? '' : r[0]); });
      while (col.length && String(col[col.length - 1]).trim() === '') col.pop(); // drop trailing blanks
      // Context column (per row, aligned with the source strings) — e.g. the review-assets link.
      var ctxArr = [];
      if (rCtxCol && col.length) ctxArr = rsheet.getRange(2, rCtxCol, col.length, 1).getValues().map(function (r) { return String(r[0] == null ? '' : r[0]); });
      return _json({ ok: true, strings: col, context: ctxArr });
    }

    // Upload a Wrike attachment to Drive (subfolder = ticket) and put its shareable link in the
    // "Context" column of every content row. Needs Drive permission (re-authorize on redeploy).
    if (p.mode === 'attachToSheet') {
      var parent = DriveApp.getFolderById(String(p.parentFolderId));
      var subName = String(p.ticket || 'misc');
      var fit0 = parent.getFoldersByName(subName);
      var sub = fit0.hasNext() ? fit0.next() : parent.createFolder(subName);
      var fname = String(p.fileName || (subName + '-file'));
      var files = sub.getFilesByName(fname);
      var file = files.hasNext() ? files.next()
        : sub.createFile(Utilities.newBlob(Utilities.base64Decode(String(p.dataBase64 || '')), String(p.contentType || 'application/octet-stream'), fname));
      try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (shErr) {}
      var link = file.getUrl();
      // write the link into the Context column for every row that has Original content
      var ass = SpreadsheetApp.openById(ssId);
      var ash = ass.getSheetByName(String(p.tab));
      var written = 0;
      if (ash) {
        var aLastCol = ash.getLastColumn(), aLastRow = ash.getLastRow();
        if (aLastRow >= 2 && aLastCol >= 1) {
          var ahdr = ash.getRange(1, 1, 1, aLastCol).getValues()[0];
          var ctxCol = 0, srcCol = 0;
          for (var hi = 0; hi < ahdr.length; hi++) { var hh = String(ahdr[hi]).trim().toLowerCase(); if (hh === 'context') ctxCol = hi + 1; if (hh === 'original content') srcCol = hi + 1; }
          if (ctxCol && srcCol) {
            var srcVals = ash.getRange(2, srcCol, aLastRow - 1, 1).getValues();
            for (var ri = 0; ri < srcVals.length; ri++) {
              if (String(srcVals[ri][0]).trim() !== '') {
                var label = 'Visual asset: ', full = label + link;
                var rich = SpreadsheetApp.newRichTextValue().setText(full).setLinkUrl(label.length, full.length, link).build();
                ash.getRange(ri + 2, ctxCol).setRichTextValue(rich); written++;
              }
            }
          }
        }
      }
      return _json({ ok: true, mode: 'attachToSheet', url: link, folderId: sub.getId(), fileId: file.getId(), rows: written });
    }

    // Import translations from Crowdin into an existing tab's language columns.
    if (p.mode === 'importTranslations') {
      var iss = SpreadsheetApp.openById(ssId);
      var isheet = iss.getSheetByName(String(p.tab));
      if (!isheet) return _json({ ok: false, error: 'tab not found: ' + p.tab });
      var lastCol = isheet.getLastColumn();
      var head = isheet.getRange(1, 1, 1, lastCol).getValues()[0];
      var colOf = {};
      for (var ci = 0; ci < head.length; ci++) { var h = String(head[ci]).trim().toUpperCase(); if (h) colOf[h] = ci + 1; }
      var written = 0;
      (p.rows || []).forEach(function (row) {
        var r = Number(row.n) + 1; // row 1 = header, so string N is row N+1
        var cells = row.cells || {};
        Object.keys(cells).forEach(function (code) {
          var col = colOf[String(code).trim().toUpperCase()];
          if (col && cells[code] !== '' && cells[code] != null) { isheet.getRange(r, col).setValue(cells[code]); written++; }
        });
      });
      return _json({ ok: true, mode: 'importTranslations', written: written });
    }

    var ss = SpreadsheetApp.openById(ssId);
    var name = String(p.tab).slice(0, 90).replace(/[:\\\/?*\[\]]/g, '-');
    var sheet = ss.getSheetByName(name);
    var existed = !!sheet;
    if (!sheet) sheet = ss.insertSheet(name, 0);

    var langs = (p.langCodes || []).slice();
    // EN-AU always goes in the last language column (if present)
    var enau = langs.filter(function (l) { return String(l).toUpperCase() === 'EN-AU'; });
    if (enau.length) langs = langs.filter(function (l) { return String(l).toUpperCase() !== 'EN-AU'; }).concat(enau);
    var header = ['Project name', 'Context', 'Languages codes', 'Original content'].concat(langs);
    var strings = (p.strings && p.strings.length) ? p.strings : [''];

    // header row (full width) — blue background, bold white text
    var hdr = sheet.getRange(1, 1, 1, header.length);
    hdr.setValues([header]);
    hdr.setBackground('#4285f4').setFontColor('#ffffff').setFontWeight('bold');
    // body: only columns A–D (leave translation columns E+ untouched)
    var body = strings.map(function (s, i) {
      return [ i === 0 ? (p.projectName || '') : '', '', i === 0 ? langs.join(', ') : '', s ];
    });
    sheet.getRange(2, 1, body.length, 4).setValues(body);
    // wrap every cell in the written block
    sheet.getRange(1, 1, 1 + body.length, header.length).setWrap(true);
    sheet.setFrozenRows(1);

    // A12 — the main task (Wrike card) link, bold and clipped (never wrapped)
    if (p.link) {
      var link = String(p.link);
      var bold = SpreadsheetApp.newTextStyle().setBold(true).build();
      var rich = SpreadsheetApp.newRichTextValue().setText(link).setLinkUrl(link).setTextStyle(0, link.length, bold).build();
      var a12 = sheet.getRange('A12');
      a12.setRichTextValue(rich);
      a12.setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
    }

    // widen every written column ~70% over the 100px default (idempotent on re-send)
    for (var col = 1; col <= header.length; col++) sheet.setColumnWidth(col, 170);

    return _json({ ok: true, tab: name, existed: existed, rows: body.length, ip: p.ip });
  } catch (err) {
    return _json({ ok: false, error: String(err) });
  }
}

// Simple GET so you can confirm the deployment is live in a browser.
// `capabilities` lets the dashboard detect (read-only) that this version supports the newer modes,
// so it never sends an unrecognized mode to an old deployment.
function doGet() {
  return _json({ ok: true, service: 'brief-tracker sheets connector', capabilities: ['listTabs', 'importTranslations', 'readSource', 'attachToSheet', 'ensureFolder', 'lqaReport'], sheets: Object.keys(SHEETS) });
}

function _json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
