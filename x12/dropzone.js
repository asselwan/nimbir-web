// app/x12/dropzone.js
// "Drop your own 835 and see your denial queue in 60 seconds" — all drag-drop,
// file-picker, parsing-trigger and banner logic for the work-queue first screen.
// Everything here runs in this browser tab only: FileReader reads the dropped
// file, parse835()/fromX12Text() parse it in memory, and nothing is ever sent to
// a server (no fetch/XHR call appears anywhere in this file).
//
// app/app.js keeps its own `claims`/`source`/`render` variables; this module
// never reaches into app.js's scope directly. Instead app.js calls
// `window.Nimbir835Dropzone.init({...})` once, at the very end of its own file,
// handing over small accessor closures — see the single delimited hook block in
// app/app.js for the other half of this wiring.

(function () {
  'use strict';

  function byId(id) { return document.getElementById(id); }

  function downloadBlob(text, mime, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: mime }));
    a.download = filename;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function init(hooks) {
    const area = byId('x12-drop-area');
    const input = byId('x12-file-input');
    const status = byId('x12-drop-status');
    const resetButton = byId('x12-drop-reset');
    if (!area || !input || !status) return; // markup not present on this page; no-op

    // De-identified export panel (council-approved pilot ask, D-nimbir-835-dropin).
    const deidSection = byId('x12-deid-export');
    const deidBanner = byId('x12-deid-banner');
    const deidBuild = byId('x12-deid-build');
    const deidDownloadJson = byId('x12-deid-download-json');
    const deidDownloadCsv = byId('x12-deid-download-csv');
    const deidPreview = byId('x12-deid-preview');
    const deidPreviewText = byId('x12-deid-preview-text');
    if (deidBanner && window.NimbirDeidExport) deidBanner.textContent = window.NimbirDeidExport.BANNER_TEXT;

    let lastFileText = null;
    let lastFileName = null;
    let lastDeidResult = null;

    function resetDeidPanel() {
      lastFileText = null;
      lastFileName = null;
      lastDeidResult = null;
      if (deidSection) deidSection.hidden = true;
      if (deidPreview) deidPreview.hidden = true;
      if (deidDownloadJson) deidDownloadJson.hidden = true;
      if (deidDownloadCsv) deidDownloadCsv.hidden = true;
    }

    function setStatus(text, isError) {
      status.textContent = text;
      status.classList.toggle('x12-drop-error', !!isError);
    }

    function applySourceLabel(labelText) {
      document.querySelectorAll('[data-source-label]').forEach(el => { el.textContent = labelText; });
    }

    function ingest(result, fileName) {
      const rows = result.claim_lines;
      if (!rows.length) {
        setStatus(`"${fileName}" parsed, but it contains no 835 claim lines to show. Showing the default dataset.`, true);
        return;
      }
      hooks.setClaims(rows);
      hooks.setSource({
        schema_version: result.schema_version,
        data_kind: result.data_kind,
        source_note: result.source_note,
        display_label: `Your file: ${fileName}`
      });
      applySourceLabel(`Your file: ${fileName}`);
      const totals = result.totals;
      const deniedBits = Object.keys(totals.byCARC).length
        ? ` $${totals.deniedTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} denied across ${Object.keys(totals.byCARC).length} CARC code(s), ${Object.keys(totals.byCPT).length} CPT code(s) affected.`
        : ' No CO (denied) adjustments found in this file.';
      setStatus(`Your file — parsed locally in this browser, nothing uploaded. ${rows.length} claim line(s) from "${fileName}".${deniedBits}`, false);
      const scope = byId('queue-scope');
      if (scope) scope.textContent = `Scope: ${rows.length} encounters from your uploaded 835 · Parsed locally · ${result.source_note}`;
      const reportSource = byId('report-source');
      if (reportSource) reportSource.textContent = `Scope: ${rows.length} encounters · Source: ${fileName} (your upload, parsed locally) · No production outcome claim.`;
      byId('export') && (byId('export').disabled = false);
      byId('run-report') && (byId('run-report').disabled = false);
      byId('review-next') && (byId('review-next').disabled = false);
      resetButton.hidden = false;
      // A freshly-ingested file can be exported de-identified, but each new file needs a fresh
      // "build" click (not an automatic export) so the preview always matches what the person
      // is about to download.
      lastDeidResult = null;
      if (deidPreview) deidPreview.hidden = true;
      if (deidDownloadJson) deidDownloadJson.hidden = true;
      if (deidDownloadCsv) deidDownloadCsv.hidden = true;
      if (deidSection) deidSection.hidden = false;
      hooks.render();
    }

    function handleFile(file) {
      if (!file) return;
      setStatus(`Reading "${file.name}"…`, false);
      const reader = new FileReader();
      reader.onerror = () => setStatus(`Could not read "${file.name}" from this browser. Showing the default dataset.`, true);
      reader.onload = () => {
        const text = String(reader.result || '');
        try {
          const result = window.NimbirFromX12.fromX12Text(text, { fileName: file.name });
          lastFileText = text;
          lastFileName = file.name;
          ingest(result, file.name);
        } catch (err) {
          setStatus(`Could not parse "${file.name}" as an X12 835 (${err.message}). Showing the default dataset.`, true);
        }
      };
      reader.readAsText(file);
    }

    input.addEventListener('change', () => handleFile(input.files && input.files[0]));

    area.addEventListener('dragover', e => { e.preventDefault(); area.classList.add('dragover'); });
    area.addEventListener('dragleave', () => area.classList.remove('dragover'));
    area.addEventListener('drop', e => {
      e.preventDefault();
      area.classList.remove('dragover');
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      handleFile(file);
    });
    area.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
    });

    if (deidBuild) {
      deidBuild.addEventListener('click', async () => {
        if (!lastFileText || !window.Nimbir835 || !window.NimbirDeidExport) return;
        deidBuild.disabled = true;
        deidBuild.textContent = 'Building…';
        try {
          const parsed = window.Nimbir835.parse835(lastFileText);
          lastDeidResult = await window.NimbirDeidExport.buildDeidExport(parsed);
          if (deidPreviewText) deidPreviewText.textContent = JSON.stringify(lastDeidResult.rows.slice(0, 3), null, 2);
          if (deidPreview) deidPreview.hidden = false;
          if (deidDownloadJson) deidDownloadJson.hidden = false;
          if (deidDownloadCsv) deidDownloadCsv.hidden = false;
        } catch (err) {
          if (deidPreviewText) deidPreviewText.textContent = `Could not build the export: ${err.message}`;
          if (deidPreview) deidPreview.hidden = false;
        } finally {
          deidBuild.disabled = false;
          deidBuild.textContent = 'Build de-identified export';
        }
      });
    }
    if (deidDownloadJson) {
      deidDownloadJson.addEventListener('click', () => {
        if (!lastDeidResult) return;
        downloadBlob(lastDeidResult.json, 'application/json', 'nimbir-835-deidentified.json');
      });
    }
    if (deidDownloadCsv) {
      deidDownloadCsv.addEventListener('click', () => {
        if (!lastDeidResult) return;
        downloadBlob(lastDeidResult.csv, 'text/csv', 'nimbir-835-deidentified.csv');
      });
    }

    resetButton.addEventListener('click', () => {
      resetButton.hidden = true;
      setStatus('', false);
      input.value = '';
      resetDeidPanel();
      if (typeof hooks.reload === 'function') hooks.reload();
    });
  }

  window.Nimbir835Dropzone = { init };
})();
