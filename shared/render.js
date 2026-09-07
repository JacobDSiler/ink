/* Ink — shared email renderer.
 * Used by BOTH the app (preview) and the Worker (authoritative send), so keep it
 * dependency-free. Exposes globalThis.InkRender = { renderEmail, toText, merge, escapeHtml }.
 *
 * Body format ("Ink text"): plain paragraphs separated by blank lines, with light markup:
 *   ## Heading            > Quote            ---  (divider)
 *   **bold**  *italic*    [link text](https://…)   [button: Label](https://…)
 *   - list item
 *   ![alt](https://image.url)
 * Merge fields: {{first_name}} {{name}} {{pen_name}} {{unsubscribe_url}} {{web_url}} {{buy_url}} {{keep_url}}
 */
(function (root) {
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function firstName(name) {
    if (!name) return '';
    return String(name).trim().split(/\s+/)[0];
  }

  // Replace merge fields. `vars` values are already plain text; escaping happens
  // after merging when rendering HTML, so merge on the source text.
  function merge(text, vars) {
    vars = vars || {};
    var fn = vars.first_name != null ? vars.first_name : firstName(vars.name);
    var map = {
      first_name: fn || vars.fallback_name || 'friend',
      name: vars.name || fn || vars.fallback_name || 'friend',
      pen_name: vars.pen_name || '',
      unsubscribe_url: vars.unsubscribe_url || '#',
      web_url: vars.web_url || '',
      book_title: vars.book_title || '',
      buy_url: vars.buy_url || '',
      keep_url: vars.keep_url || '#'
    };
    return String(text || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, function (m, k) {
      k = k.toLowerCase();
      return map[k] != null ? map[k] : m;
    });
  }

  function inline(s, brand) {
    var out = escapeHtml(s);
    // images first so their URLs are not linkified
    out = out.replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, function (m, alt, url) {
      return '<img src="' + url + '" alt="' + alt + '" style="max-width:100%;height:auto;display:block;margin:0 auto;border-radius:4px;">';
    });
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|\{\{[a-z_]+\}\}|#)\)/g, function (m, t, url) {
      return '<a href="' + url + '" style="color:' + brand.link + ';text-decoration:underline;">' + t + '</a>';
    });
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    return out;
  }

  function renderBlocks(body, brand) {
    var blocks = String(body || '').replace(/\r\n/g, '\n').split(/\n{2,}/);
    var html = [];
    var P = 'margin:0 0 1.25em 0;font-size:17px;line-height:1.7;color:' + brand.text + ';';
    blocks.forEach(function (raw) {
      var b = raw.trim();
      if (!b) return;
      var btn = b.match(/^\[button:\s*([^\]]+)\]\((https?:\/\/[^)\s]+|\{\{[a-z_]+\}\})\)$/i);
      if (btn) {
        html.push('<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 1.5em auto;"><tr><td align="center" bgcolor="' + brand.accent + '" style="border-radius:4px;">' +
          '<a href="' + btn[2] + '" style="display:inline-block;padding:14px 28px;font-family:Georgia,serif;font-size:16px;letter-spacing:.04em;color:' + brand.accentText + ';text-decoration:none;font-weight:600;">' + escapeHtml(btn[1]) + '</a></td></tr></table>');
        return;
      }
      if (/^---+$/.test(b)) {
        html.push('<div style="border-top:1px solid ' + brand.rule + ';margin:1.75em 0;"></div>');
        return;
      }
      if (/^##\s+/.test(b)) {
        html.push('<h2 style="font-family:Georgia,serif;font-size:22px;font-weight:600;line-height:1.3;margin:1.4em 0 .6em 0;color:' + brand.heading + ';">' + inline(b.replace(/^##\s+/, ''), brand) + '</h2>');
        return;
      }
      if (/^>\s?/.test(b)) {
        var q = b.split('\n').map(function (l) { return l.replace(/^>\s?/, ''); }).join('<br>');
        html.push('<blockquote style="margin:0 0 1.25em 0;padding:.4em 0 .4em 1.2em;border-left:3px solid ' + brand.accent + ';font-style:italic;font-size:17px;line-height:1.7;color:' + brand.text + ';">' + inline(q, brand).replace(/&lt;br&gt;/g, '<br>') + '</blockquote>');
        return;
      }
      if (/^(-|\*)\s+/m.test(b) && b.split('\n').every(function (l) { return /^(-|\*)\s+/.test(l); })) {
        html.push('<ul style="margin:0 0 1.25em 1.2em;padding:0;font-size:17px;line-height:1.7;color:' + brand.text + ';">' +
          b.split('\n').map(function (l) { return '<li style="margin:0 0 .4em 0;">' + inline(l.replace(/^(-|\*)\s+/, ''), brand) + '</li>'; }).join('') + '</ul>');
        return;
      }
      if (/^!\[/.test(b)) {
        html.push('<div style="margin:0 0 1.25em 0;">' + inline(b, brand) + '</div>');
        return;
      }
      html.push('<p style="' + P + '">' + inline(b, brand).replace(/\n/g, '<br>') + '</p>');
    });
    return html.join('\n');
  }

  var DEFAULT_BRAND = {
    bg: '#f4f1ea', card: '#ffffff', text: '#2a2218', heading: '#1c2b4a', accent: '#a66e22',
    accentText: '#ffffff', link: '#a66e22', rule: '#e6dfd0', muted: '#8a8071', font: "Georgia, 'Times New Roman', serif"
  };

  /**
   * renderEmail({ subject, previewText, body, brand, author:{penName, address, webUrl, signature}, vars })
   * returns { html, text }
   */
  function renderEmail(opts) {
    var brand = Object.assign({}, DEFAULT_BRAND, opts.brand || {});
    var author = opts.author || {};
    var vars = Object.assign({ pen_name: author.penName || '', web_url: author.webUrl || '' }, opts.vars || {});
    var body = merge(opts.body || '', vars);
    var subject = merge(opts.subject || '', vars);
    var preview = merge(opts.previewText || '', vars);
    var unsub = vars.unsubscribe_url || '#';

    var content = renderBlocks(body, brand);
    var footerLines = [];
    if (author.penName) footerLines.push(escapeHtml(author.penName));
    if (author.address) footerLines.push(escapeHtml(author.address));
    footerLines.push('You are receiving this because you joined ' + escapeHtml(author.penName || 'this') + "'s reader list. " +
      '<a href="' + unsub + '" style="color:' + brand.muted + ';text-decoration:underline;">Unsubscribe</a>');
    var footer = footerLines.join('<br>');

    var html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>' + escapeHtml(subject) + '</title></head>' +
      '<body style="margin:0;padding:0;background:' + brand.bg + ';">' +
      (preview ? '<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">' + escapeHtml(preview) + Array(40).join('&nbsp;&zwnj;') + '</div>' : '') +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:' + brand.bg + ';"><tr><td align="center" style="padding:32px 12px;">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:' + brand.card + ';border-radius:6px;">' +
      '<tr><td style="padding:40px 40px 24px 40px;font-family:' + brand.font + ';">' +
      (author.penName ? '<div style="font-family:' + brand.font + ';font-size:13px;letter-spacing:.18em;text-transform:uppercase;color:' + brand.muted + ';margin-bottom:28px;">' + escapeHtml(author.penName) + '</div>' : '') +
      content +
      (author.signature ? '<p style="margin:1.5em 0 0 0;font-size:17px;line-height:1.7;color:' + brand.text + ';">' + escapeHtml(author.signature).replace(/\n/g, '<br>') + '</p>' : '') +
      '</td></tr>' +
      '<tr><td style="padding:20px 40px 32px 40px;border-top:1px solid ' + brand.rule + ';font-family:' + brand.font + ';font-size:12px;line-height:1.6;color:' + brand.muted + ';">' + footer + '</td></tr>' +
      '</table></td></tr></table></body></html>';

    return { html: html, text: toText(body, author, unsub), subject: subject, previewText: preview };
  }

  function toText(body, author, unsub) {
    var t = String(body || '')
      .replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, '$2')
      .replace(/\[button:\s*([^\]]+)\]\(([^)\s]+)\)/gi, '$1: $2')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)')
      .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
      .replace(/^##\s+/gm, '').replace(/^>\s?/gm, '  ');
    var foot = '\n\n—\n' + (author && author.penName ? author.penName + '\n' : '') + (author && author.address ? author.address + '\n' : '') + 'Unsubscribe: ' + (unsub || '');
    return t + foot;
  }

  root.InkRender = { renderEmail: renderEmail, toText: toText, merge: merge, escapeHtml: escapeHtml, DEFAULT_BRAND: DEFAULT_BRAND, firstName: firstName };
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this);
