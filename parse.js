// parse.js — a Markdown-to-HTML renderer that reproduces, byte for byte,
// the output of marked 18.1.3 running with its default options
// (gfm: true, breaks: false, pedantic: false).
//
// The grammar patterns are those of marked 18.1.3 (MIT License,
// (c) 2018-2026 MarkedJS, (c) 2011-2018 Christopher Jeffrey): exact output
// equality — including marked's departures from the CommonMark and GFM
// specs — is only possible with the reference grammar, so the patterns
// below are assembled from the same fragments, in the same way, as the
// reference grammar. Everything around them is built for speed:
//
//   * the block scanner walks the source once with an index, matching
//     sticky patterns at the cursor instead of re-slicing the unparsed
//     remainder for every token attempt;
//   * cheap first-character gates keep the heavyweight patterns (table,
//     setext heading, blockquote) from running where they cannot match;
//   * the inline scanner dispatches on the current character, scans plain
//     text with a hand-written run scanner, and skips masking work that
//     provably cannot change the run;
//   * emphasis closers are located with one shared pre-scan per run.
//
// parse() is deterministic and pure; the module has no dependencies.

'use strict';

// ---------------------------------------------------------------------------
// Pattern assembly. `shape` mirrors the reference grammar's own builder:
// start from a core pattern containing named holes and substitute each
// hole with a fragment; a fragment's leading ^ anchors are dropped as it
// is spliced in (the hole always sits where an anchor is meaningless).
// ---------------------------------------------------------------------------

function shape(core, flags) {
  let src = typeof core === 'string' ? core : core.source;
  const api = {
    fill(name, fragment) {
      let frag = typeof fragment === 'string' ? fragment : fragment.source;
      frag = frag.replace(/(^|[^\[])\^/g, '$1');
      src = src.replace(name, frag);
      return api;
    },
    done() {
      return new RegExp(src, flags || '');
    },
  };
  return api;
}

// The block-level HTML tag names, as one alternation fragment.
const TAG_WORDS = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';

// A link label at block level (definitions, reference uses): no unescaped
// brackets, no blank lines inside.
const BLOCK_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;

// One balanced pair of brackets with no bracket inside.
const BRACKET_PAIR = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;

// An inline link label: brackets nest through BRACKET_PAIR, code spans and
// escapes are skipped over, lazily up to the closing bracket.
const INLINE_LABEL = shape(/(?:\[(?:PAIR|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .fill('PAIR', BRACKET_PAIR)
  .done();

// Bounded variants used by the reference search: at most 999 units, so a
// candidate that can never match cannot scan quadratically.
const BOUNDED_BLOCK_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const BOUNDED_INLINE_LABEL = shape(/(?:[^\[\]\\`]*(?:\[(?:PAIR|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/)
  .fill('PAIR', BRACKET_PAIR)
  .done();

// ---------------------------------------------------------------------------
// Block grammar
// ---------------------------------------------------------------------------

const P_NEWLINE = /^(?:[ \t]*(?:\n|$))+/;
const P_INDENT_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const P_FENCES = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const P_HR = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const P_HEADING = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const BULLET = / {0,3}(?:[*+-]|\d{1,9}[.)])/;

const SETEXT_CORE = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
function buildSetext(withTable) {
  const b = shape(SETEXT_CORE)
    .fill(/bull/g, BULLET)
    .fill(/blockCode/g, /(?: {4}| {0,3}\t)/)
    .fill(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
    .fill(/blockquote/g, / {0,3}>/)
    .fill(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
    .fill(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
    .fill(/html/g, / {0,3}<[^\n>]+>\n/);
  if (withTable) {
    b.fill(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/);
  } else {
    b.fill(/\|table/g, '');
  }
  return b.done();
}
const P_SETEXT = buildSetext(true);

const P_DEF = shape(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .fill('label', BLOCK_LABEL)
  .fill('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .done();

const P_LIST = shape(/^(bull)([ \t][^\n]*?)?(?:\n|$)/)
  .fill(/bull/g, BULLET)
  .done();

const HTML_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const P_HTML = shape(
  '^ {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)'
  + '|comment[^\\n]*(\\n+|$)'
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)'
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)'
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)'
  + '|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + ')', 'i')
  .fill('comment', HTML_COMMENT)
  .fill('tag', TAG_WORDS)
  .fill('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .done();

const PARAGRAPH_CORE = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
function buildParagraph(listInterrupt, withTable) {
  const b = shape(PARAGRAPH_CORE)
    .fill('hr', P_HR)
    .fill('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .fill('|lheading', '');
  if (withTable) {
    b.fill('table', P_TABLE);
  } else {
    b.fill('|table', '');
  }
  return b
    .fill('blockquote', ' {0,3}>')
    .fill('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .fill('list', listInterrupt)
    .fill('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
    .fill('tag', TAG_WORDS)
    .done();
}

const P_TABLE = shape(
  '^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
  .fill('hr', P_HR)
  .fill('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .fill('blockquote', ' {0,3}>')
  .fill('code', '(?: {4}| {0,3}\t)[^\\n]')
  .fill('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .fill('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .fill('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .fill('tag', TAG_WORDS)
  .done();

const P_PARAGRAPH = buildParagraph(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/, true);
const P_QUOTE_PARAGRAPH = buildParagraph(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/, false);

const P_BLOCKQUOTE = shape(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/)
  .fill('paragraph', P_QUOTE_PARAGRAPH)
  .done();

const P_BLOCK_TEXT = /^[^\n]+/;

// ---------------------------------------------------------------------------
// Inline grammar
// ---------------------------------------------------------------------------

const P_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const P_CODESPAN = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const P_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;

const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_OR_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_OR_SPACE = /[^\s\p{P}\p{S}]/u;
const PUNCT_NO_TILDE = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_OR_SPACE_NO_TILDE = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_OR_SPACE_OR_TILDE = /(?:[^\s\p{P}\p{S}]|~)/u;

const P_PUNCTUATION = shape(/^((?![*_])punctSpace)/, 'u')
  .fill(/punctSpace/g, PUNCT_OR_SPACE)
  .done();

const P_BLOCK_SKIP = shape(/link|precode-code|html/, 'g')
  .fill('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .fill('precode-', '(?<!`)()')
  .fill('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .fill('html', /<(?! )[^<>]*?>/)
  .done();

const EM_L_CORE = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
const P_EM_L = shape(EM_L_CORE, 'u').fill(/punct/g, PUNCT_NO_TILDE).done();

const EM_R_AST_CORE =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)'
  + '|[^*]+(?=[^*])'
  + '|(?!\\*)punct(\\*+)(?=[\\s]|$)'
  + '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)'
  + '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)'
  + '|[\\s](\\*+)(?!\\*)(?=punct)'
  + '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)'
  + '|notPunctSpace(\\*+)(?=notPunctSpace)';
const P_EM_R_AST = shape(EM_R_AST_CORE, 'gu')
  .fill(/notPunctSpace/g, NOT_PUNCT_OR_SPACE_OR_TILDE)
  .fill(/punctSpace/g, PUNCT_OR_SPACE_NO_TILDE)
  .fill(/punct/g, PUNCT_NO_TILDE)
  .done();

const EM_R_UND_SRC =
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)'
  + '|[^_]+(?=[^_])'
  + '|(?!_)punct(_+)(?=[\\s]|$)'
  + '|notPunctSpace(_+)(?!_)(?=punctSpace|$)'
  + '|(?!_)punctSpace(_+)(?=notPunctSpace)'
  + '|[\\s](_+)(?!_)(?=punct)'
  + '|(?!_)punct(_+)(?!_)(?=punct)';
const P_EM_R_UND = shape(EM_R_UND_SRC, 'gu')
  .fill(/notPunctSpace/g, NOT_PUNCT_OR_SPACE)
  .fill(/punctSpace/g, PUNCT_OR_SPACE)
  .fill(/punct/g, PUNCT)
  .done();

const P_DEL_L = shape(/^~~?(?:((?!~)punct)|[^\s~])/, 'u')
  .fill(/punct/g, PUNCT)
  .done();

const DEL_R_CORE =
  '^[^~]+(?=[^~])'
  + '|(?!~)punct(~~?)(?=[\\s]|$)'
  + '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)'
  + '|(?!~)punctSpace(~~?)(?=notPunctSpace)'
  + '|[\\s](~~?)(?!~)(?=punct)'
  + '|(?!~)punct(~~?)(?!~)(?=punct)'
  + '|notPunctSpace(~~?)(?=notPunctSpace)';
const P_DEL_R = shape(DEL_R_CORE, 'gu')
  .fill(/notPunctSpace/g, NOT_PUNCT_OR_SPACE)
  .fill(/punctSpace/g, PUNCT_OR_SPACE)
  .fill(/punct/g, PUNCT)
  .done();

const P_DEL = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;

const P_ANY_PUNCT = shape(/\\(punct)/, 'gu').fill(/punct/g, PUNCT).done();
const P_ANY_PUNCT_OUTSIDE_CODE = shape(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu')
  .fill(/punct/g, PUNCT)
  .done();

const P_AUTOLINK = shape(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .fill('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .fill('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
  .done();

const INLINE_COMMENT = shape(HTML_COMMENT).fill('(?:-->|$)', '-->').done();
const P_TAG = shape(
  '^comment'
  + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>'
  + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>'
  + '|^<\\?[\\s\\S]*?\\?>'
  + '|^<![a-zA-Z]+\\s[\\s\\S]*?>'
  + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>')
  .fill('comment', INLINE_COMMENT)
  .fill('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
  .done();

const P_LINK = shape(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .fill('label', INLINE_LABEL)
  .fill('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .fill('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .done();

const P_REFLINK = shape(/^!?\[(label)\]\[(ref)\]/)
  .fill('label', INLINE_LABEL)
  .fill('ref', BLOCK_LABEL)
  .done();

const P_NOLINK = shape(/^!?\[(ref)\](?:\[\])?/)
  .fill('ref', BLOCK_LABEL)
  .done();

const P_REFLINK_SEARCH = shape('reflink|nolink(?!\\()', 'g')
  .fill('reflink', shape(/^!?\[(label)\]\[(ref)\]/)
    .fill('label', BOUNDED_INLINE_LABEL)
    .fill('ref', BOUNDED_BLOCK_LABEL)
    .done())
  .fill('nolink', shape(/^!?\[(ref)\](?:\[\])?/)
    .fill('ref', BOUNDED_BLOCK_LABEL)
    .done())
  .done();

const PROTOCOL_WORD = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const EXT_EMAIL = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EMAIL_PROTOCOL = shape(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
  .fill(/email/g, EXT_EMAIL)
  .done();

const P_URL = shape(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .fill('emailProtocol', EMAIL_PROTOCOL)
  .fill('protocol', PROTOCOL_WORD)
  .fill('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
  .done();

const P_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

// The reference inline text pattern. My scanner below reproduces its
// matches by hand; the pattern itself is kept for the cases the scanner
// declines (none in the current build) and for differential testing.
const P_TEXT = shape(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|__BWORD_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
  .fill('protocol', PROTOCOL_WORD)
  .fill(/emailProtocol/g, /(?:mailto|xmpp):/)
  .fill('wwwStart', '(?<![^\\s*_~(])www\\.')
  .fill('__BWORD_', '\\b_')
  .done();

// ---------------------------------------------------------------------------
// Small "other" patterns, used the way the reference uses them.
// ---------------------------------------------------------------------------

const O_CODE_REMOVE_INDENT = /^(?: {0,3}\t| {1,4})/gm;
const O_OUTPUT_LINK_REPLACE = /\\([\[\]])/g;
const O_INDENT_CODE_COMP = /^(\s+)(?:```)/;
const O_BEGINNING_SPACE = /^\s+/;
const O_ENDING_HASH = /#$/;
const O_STARTING_SPACE = /^ /;
const O_ENDING_SPACE = / $/;
const O_ENDING_SPACE_TAB = /[ \t]$/;
const O_NON_SPACE = /[^ ]/;
const O_NEWLINE_G = /\n/g;
const O_TAB_G = /\t/g;
const O_LEADING_SPACE_TAB = /^[ \t]+/;
const O_MULTISPACE_G = /\s+/g;
const O_BLANK_LINE = /^[ \t]*$/;
const O_DOUBLE_BLANK = /\n[ \t]*\n[ \t]*$/;
const O_QUOTE_START = /^ {0,3}>/;
const O_QUOTE_SETEXT = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const O_QUOTE_MARKER = /^ {0,3}>[ \t]?/gm;
const O_QUOTE_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const O_LIST_NESTING = /^ {1,4}(?=( {4})*[^ ])/g;
const O_TASK = /^\[[ xX]\][ \t]+\S/;
const O_TASK_STRIP = /^\[[ xX]\][ \t]+/;
const O_TASK_BOX = /\[[ xX]\]/;
const O_ANY_LINE = /\n.*\n/;
const O_HREF_BRACKETS = /^<(.*)>$/;
const O_TABLE_DELIM = /[:|]/;
const O_TABLE_ALIGN_CHARS = /^\||\| *$/g;
const O_TABLE_ROW_BLANK = /\n[ \t]*$/;
const O_TABLE_ALIGN_R = /^ *-+: *$/;
const O_TABLE_ALIGN_C = /^ *:-+: *$/;
const O_TABLE_ALIGN_L = /^ *:-+ *$/;
const O_START_A = /^<a /i;
const O_END_A = /^<\/a>/i;
const O_START_PRE = /^<(pre|code|kbd|script)(\s|>)/i;
const O_END_PRE = /^<\/(pre|code|kbd|script)(\s|>)/i;
const O_START_ANGLE = /^</;
const O_END_ANGLE = />$/;
const O_ALNUM = /[\p{L}\p{N}]/u;
const O_NUMREF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const O_NUMREF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const O_ESC_TEST = /[&<>"']/;
const O_ESC_REPLACE = /[&<>"']/g;
const O_ESC_TEST_NE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const O_ESC_REPLACE_NE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const O_PERCENT25 = /%25/g;
const O_FIND_PIPE = /\|/g;
const O_SPLIT_PIPE = / \|/;
const O_SLASH_PIPE = /\\\|/g;
const O_CR = /\r\n|\r/g;
const O_NOT_SPACE_START = /^\S*/;
const O_ENDING_NL = /\n$/;

// List helper factories. The reference caches these by a clamped index:
// an indent of 1..4+ maps to cache slots 0..3 and the pattern is built
// from the slot number, so indents above 4 share the slot-3 pattern and
// an indent of n (2..4) builds the pattern for n-1. Ported as-is.
function indentFactory(make) {
  const cache = [];
  return (indent) => {
    const slot = Math.max(0, Math.min(3, indent - 1));
    let re = cache[slot];
    if (!re) {
      re = make(slot);
      cache[slot] = re;
    }
    return re;
  };
}
const itemPattern = (bull) => new RegExp(`^( {0,3}${bull})((?:[\t ][^\\n]*)?(?:\\n|$))`);
const itemRegexCache = new Map();
function itemRegexFor(bull) {
  let re = itemRegexCache.get(bull);
  if (re === undefined) {
    re = itemPattern(bull);
    itemRegexCache.set(bull, re);
  }
  return re;
}

// The list item pattern, as a sticky regex (cached per bullet string), for
// matching at an offset inside the list source.
const itemStickyCache = new Map();
function itemStickyFor(bull) {
  let re = itemStickyCache.get(bull);
  if (re === undefined) {
    re = stickyOf(itemPattern(bull));
    itemStickyCache.set(bull, re);
  }
  return re;
}
const nextBulletPattern = indentFactory((n) => new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`));
const hrPattern = indentFactory((n) => new RegExp(`^ {0,${n}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`));
const fencesBeginPattern = indentFactory((n) => new RegExp('^ {0,' + n + '}(?:\\`\\`\\`|~~~)'));
const headingBeginPattern = indentFactory((n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`));
const htmlBeginPattern = indentFactory((n) => new RegExp(`^ {0,${n}}(?:</?(?:${TAG_WORDS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
const quoteBeginPattern = indentFactory((n) => new RegExp(`^ {0,${n}}>`));
// ============================================================
// Text helpers
// ============================================================

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escape &, <, >, ", '. With encode=false, an & that already opens a valid
// entity is left alone.
function escapeHtmlEntities(text, encode) {
  if (encode) {
    return O_ESC_TEST.test(text) ? text.replace(O_ESC_REPLACE, (c) => ESC_MAP[c]) : text;
  }
  return O_ESC_TEST_NE.test(text) ? text.replace(O_ESC_REPLACE_NE, (c) => ESC_MAP[c]) : text;
}

// `&#123;` / `&#x1F600;` become the code point (with replacement-char rules);
// every other bare & in the same pass becomes &amp; so a decoded character
// cannot join its neighbours into a new reference.
function decodeNumericRefs(text) {
  if (!O_NUMREF.test(text)) return text;
  return text.replace(O_NUMREF_OR_AMP, (_ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  try {
    return encodeURI(href).replace(O_PERCENT25, '%');
  } catch {
    return null;
  }
}

// Strip a trailing run of one character.
function rtrim(str, c) {
  const l = str.length;
  if (l === 0) return '';
  let suffLen = 0;
  while (suffLen < l && str.charAt(l - suffLen - 1) === c) suffLen++;
  return str.slice(0, l - suffLen);
}

// Remove trailing blank lines, but keep the string untouched when at most
// one blank line would go (a single trailing blank line is kept).
function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && O_BLANK_LINE.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}

// Case-fold a link label and collapse its whitespace, memoised per parse.
function normalizeLabel(label, cache) {
  let v = cache.get(label);
  if (v === undefined) {
    v = label.trim().replace(O_MULTISPACE_G, ' ').toLowerCase().toUpperCase().toLowerCase();
    cache.set(label, v);
  }
  return v;
}

// Index where brackets (the two chars of `pair`) first go negative, -2 when
// opens remain unclosed, -1 when balanced or neither bracket occurs.
// Backslash-escaped brackets do not count.
function findClosingBracket(str, pair) {
  if (str.indexOf(pair[0]) === -1 && str.indexOf(pair[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') {
      i++;
    } else if (str[i] === pair[0]) {
      level++;
    } else if (str[i] === pair[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  return level > 0 ? -2 : -1;
}

// Expand tabs to the next multiple-of-4 column, starting at column `indent`.
function expandTabs(line, indent = 0) {
  let col = indent;
  let out = '';
  for (const ch of line) {
    if (ch === '\t') {
      const added = 4 - (col % 4);
      out += ' '.repeat(added);
      col += added;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// Split a table row into cells: unescaped pipes become delimiters (a space
// is forced before each so ` |` splits cleanly), escaped pipes become
// literal pipes, edge empty cells drop, and the row is padded/truncated to
// `count` cells when a count is given.
function splitCells(row, count) {
  const spaced = row.replace(O_FIND_PIPE, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = spaced.split(O_SPLIT_PIPE);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) {
    cells[i] = cells[i].trim().replace(O_SLASH_PIPE, '|');
  }
  return cells;
}

// Remove up to the fence's own indentation from each content line.
function fenceIndentCompensation(raw, text) {
  const m = raw.match(O_INDENT_CODE_COMP);
  if (m === null) return text;
  const indent = m[1];
  return text.split('\n').map((line) => {
    const lm = line.match(O_BEGINNING_SPACE);
    if (lm === null) return line;
    return line.slice(Math.min(lm[0].length, indent.length));
  }).join('\n');
}

// ============================================================
// Sticky twins: the same patterns anchored at an index instead
// of at a substring start, so the scanners never copy the tail
// of the document just to test a token.
// ============================================================

function stickyOf(re) {
  // The sticky flag anchors the match at lastIndex, which makes the
  // pattern's own ^ anchors (start, or right after a | or group open)
  // redundant — and harmful, since ^ still means string start. Drop them,
  // leaving ^ inside character classes and escaped \^ untouched.
  const src = re.source;
  let out = '';
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { out += c + (src[i + 1] ?? ''); i++; continue; }
    if (inClass) { out += c; if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; out += c; continue; }
    if (c === '^' && (out === '' || out.endsWith('|') || out.endsWith('('))) continue;
    out += c;
  }
  return new RegExp(out, re.flags.includes('y') ? re.flags : re.flags + 'y');
}

const S_NEWLINE = stickyOf(P_NEWLINE);
const S_INDENT_CODE = stickyOf(P_INDENT_CODE);
const S_FENCES = stickyOf(P_FENCES);
const S_HEADING = stickyOf(P_HEADING);
const S_HR = stickyOf(P_HR);
const S_BLOCKQUOTE = stickyOf(P_BLOCKQUOTE);
const S_LIST = stickyOf(P_LIST);
const S_HTML = stickyOf(P_HTML);
const S_DEF = stickyOf(P_DEF);
const S_TABLE = stickyOf(P_TABLE);
const S_SETEXT = stickyOf(P_SETEXT);
const S_PARAGRAPH = stickyOf(P_PARAGRAPH);
const S_BLOCK_TEXT = stickyOf(P_BLOCK_TEXT);

function execAt(re, text, pos) {
  re.lastIndex = pos;
  return re.exec(text);
}

// ============================================================
// Block phase
//
// Tokens are plain objects with a `t` field. Inline content is
// not parsed during the block phase; each token that carries
// inline text registers a job on ctx.queue (in creation order)
// and the jobs run after the whole block tree exists.
// ============================================================

function newParseCtx() {
  return {
    links: Object.create(null), // labels like "__proto__" must behave
    hasLinks: false,
    queue: [],
    top: true,
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    labelCache: new Map(),
  };
}

function queueInline(ctx, text, tok) {
  ctx.queue.push({ src: text, tokens: tok.tokens });
}

// Could the line after the first one be a table delimiter row? The real
// pattern only allows spaces and | : - there, and a pipe must appear.
function tableGate(text, pos) {
  const nl = text.indexOf('\n', pos);
  if (nl === -1) return false;
  let e = text.indexOf('\n', nl + 1);
  if (e === -1) e = text.length;
  let hasPipe = false;
  for (let i = nl + 1; i < e; i++) {
    const c = text[i];
    if (c === '|') hasPipe = true;
    else if (c !== ' ' && c !== ':' && c !== '-') return false;
  }
  return hasPipe;
}

// Is any line before the next blank line a setext underline (`===`/`---`)?
// The heading's text part cannot cross a blank line, so the scan stops at
// the first one. (A "yes" only runs the real pattern; a "no" is certain,
// because any match's underline line would have been found.)
const SETEXT_LINE_ONLY = /^ {0,3}(?:=+|-+)[ \t]*$/;
const BLANK_LINE_ONLY = /^[ \t]*$/;
function setextGate(text, pos) {
  let ls = text.indexOf('\n', pos);
  if (ls === -1) return false;
  ls++;
  while (ls <= text.length) {
    let le = text.indexOf('\n', ls);
    if (le === -1) le = text.length;
    const line = text.slice(ls, le);
    if (BLANK_LINE_ONLY.test(line)) return false;
    if (SETEXT_LINE_ONLY.test(line)) return true;
    if (le === text.length) return false;
    ls = le + 1;
  }
  return false;
}

function scanBlocks(ctx, text, tokens, clipped = false) {
  let pos = 0;
  const end = text.length;
  while (pos < end) {
    const lastTok = tokens.length ? tokens[tokens.length - 1] : undefined;
    const ch = text[pos];
    let cap;

    // space (a run of blank lines / stray spaces)
    cap = (ch === ' ' || ch === '\t' || ch === '\n') ? (S_NEWLINE.lastIndex = pos, S_NEWLINE.exec(text)) : null;
    if (cap && cap[0].length > 0) {
      if (cap[0].length === 1 && lastTok !== undefined) {
        // a single \n terminates the previous token's last line
        lastTok.raw += '\n';
      } else {
        tokens.push({ t: 'space', raw: cap[0] });
      }
      pos += cap[0].length;
      continue;
    }

    // indented code (cannot interrupt a paragraph: merges into it instead)
    if ((ch === ' ' || ch === '\t') && (cap = (S_INDENT_CODE.lastIndex = pos, S_INDENT_CODE.exec(text)))) {
      const raw = trimTrailingBlankLines(cap[0]);
      const tok = { t: 'code', raw, text: raw.replace(O_CODE_REMOVE_INDENT, ''), style: 'indented' };
      if (lastTok !== undefined && (lastTok.t === 'paragraph' || lastTok.t === 'text')) {
        lastTok.raw += (lastTok.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        lastTok.text += '\n' + tok.text;
        ctx.queue[ctx.queue.length - 1].src = lastTok.text;
      } else {
        tokens.push(tok);
      }
      pos += tok.raw.length;
      continue;
    }

    // fenced code
    if ((ch === '`' || ch === '~' || ch === ' ') && (cap = (S_FENCES.lastIndex = pos, S_FENCES.exec(text)))) {
      const tok = {
        t: 'code',
        raw: cap[0],
        lang: cap[2] ? unescapePunct(cap[2].trim()) : cap[2],
        text: fenceIndentCompensation(cap[0], cap[3] || ''),
      };
      tokens.push(tok);
      pos += cap[0].length;
      continue;
    }

    // ATX heading
    if ((ch === '#' || ch === ' ') && (cap = (S_HEADING.lastIndex = pos, S_HEADING.exec(text)))) {
      let txt = cap[2].trim();
      if (O_ENDING_HASH.test(txt)) {
        const trimmed = rtrim(txt, '#');
        if (!trimmed || O_ENDING_SPACE_TAB.test(trimmed)) txt = trimmed.trim();
      }
      const tok = { t: 'heading', raw: rtrim(cap[0], '\n'), depth: cap[1].length, text: txt, tokens: [] };
      queueInline(ctx, txt, tok);
      tokens.push(tok);
      pos += tok.raw.length;
      continue;
    }

    // thematic break
    if ((ch === '-' || ch === '_' || ch === '*' || ch === ' ') && (cap = (S_HR.lastIndex = pos, S_HR.exec(text)))) {
      const tok = { t: 'hr', raw: rtrim(cap[0], '\n') };
      tokens.push(tok);
      pos += tok.raw.length;
      continue;
    }

    // blockquote
    if ((ch === '>' || ch === ' ') && (cap = (S_BLOCKQUOTE.lastIndex = pos, S_BLOCKQUOTE.exec(text)))) {
      const tok = blockquoteToken(ctx, cap);
      tokens.push(tok);
      pos += tok.raw.length;
      continue;
    }

    // list
    if (ch === ' ' || ch === '*' || ch === '-' || ch === '+' || (ch >= '0' && ch <= '9')) {
      const tok = listToken(ctx, text.slice(pos));
      if (tok) {
        tokens.push(tok);
        pos += tok.raw.length;
        continue;
      }
    }

    // html block
    if ((ch === '<' || ch === ' ') && (cap = (S_HTML.lastIndex = pos, S_HTML.exec(text)))) {
      const raw = trimTrailingBlankLines(cap[0]);
      const tok = { t: 'html', raw, pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style', text: raw };
      tokens.push(tok);
      pos += tok.raw.length;
      continue;
    }

    // link definition
    if ((ch === '[' || ch === ' ') && (cap = (S_DEF.lastIndex = pos, S_DEF.exec(text)))) {
      const tok = defToken(ctx, cap);
      if (tok) {
        if (lastTok !== undefined && (lastTok.t === 'paragraph' || lastTok.t === 'text')) {
          lastTok.raw += (lastTok.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          lastTok.text += '\n' + tok.raw;
          ctx.queue[ctx.queue.length - 1].src = lastTok.text;
        } else {
          // the first definition of a label wins; later ones still consume
          if (!ctx.links[tok.tag]) {
            ctx.links[tok.tag] = { href: tok.href, title: tok.title };
            ctx.hasLinks = true;
          }
          tokens.push(tok);
        }
        pos += tok.raw.length;
        continue;
      }
    }

    // table (behind a delimiter-line gate)
    if (tableGate(text, pos) && (cap = (S_TABLE.lastIndex = pos, S_TABLE.exec(text)))) {
      const tok = tableToken(ctx, cap);
      if (tok) {
        tokens.push(tok);
        pos += tok.raw.length;
        continue;
      }
    }

    // setext heading (behind an underline-line gate)
    if (setextGate(text, pos) && (cap = (S_SETEXT.lastIndex = pos, S_SETEXT.exec(text)))) {
      const txt = cap[1].trim();
      const tok = { t: 'heading', raw: rtrim(cap[0], '\n'), depth: cap[2].charAt(0) === '=' ? 1 : 2, text: txt, tokens: [] };
      queueInline(ctx, txt, tok);
      tokens.push(tok);
      pos += tok.raw.length;
      continue;
    }

    // paragraph (top level only)
    if (ctx.top && (cap = (S_PARAGRAPH.lastIndex = pos, S_PARAGRAPH.exec(text)))) {
      const ptext = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
      const tok = { t: 'paragraph', raw: cap[0], text: ptext, tokens: [] };
      queueInline(ctx, ptext, tok);
      if (clipped && lastTok !== undefined && lastTok.t === 'paragraph') {
        lastTok.raw += (lastTok.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        lastTok.text += '\n' + tok.text;
        ctx.queue.pop();
        ctx.queue[ctx.queue.length - 1].src = lastTok.text;
      } else {
        tokens.push(tok);
      }
      clipped = false;
      pos += cap[0].length;
      continue;
    }

    // plain text fallback (inside blocks where paragraphs are off)
    cap = (S_BLOCK_TEXT.lastIndex = pos, S_BLOCK_TEXT.exec(text));
    if (cap) {
      const tok = { t: 'text', raw: cap[0], text: cap[0], tokens: [] };
      queueInline(ctx, cap[0], tok);
      if (lastTok !== undefined && lastTok.t === 'text') {
        lastTok.raw += (lastTok.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        lastTok.text += '\n' + tok.text;
        ctx.queue.pop();
        ctx.queue[ctx.queue.length - 1].src = lastTok.text;
      } else {
        tokens.push(tok);
      }
      pos += cap[0].length;
      continue;
    }

    break; // unreachable in practice: block text matches anything
  }
  ctx.top = true;
  return tokens;
}

// Unescape punctuation (\x -> x for punctuation x); the identity when the
// string holds no backslash.
function unescapePunct(str) {
  return str.includes('\\') ? str.replace(P_ANY_PUNCT, '$1') : str;
}

function defToken(ctx, cap) {
  // outside angle brackets a destination holds only balanced parentheses
  if (!O_START_ANGLE.test(cap[2]) && findClosingBracket(cap[2], '()') !== -1) return null;
  return {
    t: 'def',
    tag: normalizeLabel(cap[1], ctx.labelCache),
    raw: rtrim(cap[0], '\n'),
    href: cap[2] ? unescapePunct(cap[2].replace(O_HREF_BRACKETS, '$1')) : '',
    title: cap[3] ? unescapePunct(cap[3].substring(1, cap[3].length - 1)) : cap[3],
  };
}

function tableToken(ctx, cap) {
  // a delimiter row needs a pipe or colon, else this is a setext heading
  if (!O_TABLE_DELIM.test(cap[2])) return null;
  const headers = splitCells(cap[1]);
  const aligns = cap[2].replace(O_TABLE_ALIGN_CHARS, '').split('|');
  if (headers.length !== aligns.length) return null;
  const align = aligns.map((a) => (
    O_TABLE_ALIGN_R.test(a) ? 'right'
      : O_TABLE_ALIGN_C.test(a) ? 'center'
        : O_TABLE_ALIGN_L.test(a) ? 'left' : null
  ));
  const tok = { t: 'table', raw: rtrim(cap[0], '\n'), align, header: [], rows: [] };
  for (let i = 0; i < headers.length; i++) {
    const cell = { text: headers[i], tokens: [], header: true, align: align[i] };
    queueInline(ctx, headers[i], cell);
    tok.header.push(cell);
  }
  const rows = cap[3]?.trim() ? cap[3].replace(O_TABLE_ROW_BLANK, '').split('\n') : [];
  for (const row of rows) {
    tok.rows.push(splitCells(row, headers.length).map((cellText, i) => {
      const cell = { text: cellText, tokens: [], header: false, align: align[i] };
      queueInline(ctx, cellText, cell);
      return cell;
    }));
  }
  return tok;
}

// Blockquote: the outer pattern grabs the whole quote region; the lines are
// then grouped into chunks at continuation boundaries. Each chunk has its
// markers stripped and is scanned as top-level blocks; leftover lines are
// folded into a nested blockquote or list when the chunk ended with one.
function blockquoteToken(ctx, cap) {
  let lines = rtrim(cap[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];

  while (lines.length > 0) {
    let inQuote = false;
    const chunk = [];
    let i;
    for (i = 0; i < lines.length; i++) {
      if (O_QUOTE_START.test(lines[i])) {
        chunk.push(lines[i]);
        inQuote = true;
      } else if (!inQuote) {
        chunk.push(lines[i]);
      } else {
        break;
      }
    }
    lines = lines.slice(i);

    const chunkRaw = chunk.join('\n');
    const chunkText = chunkRaw
      // a tab after the marker runs to the next tab stop; the marker only
      // consumes one space of it, the rest is content
      .replace(O_QUOTE_MARKER_WS, (_m, marker, ws) => marker + expandTabs(ws, marker.length))
      // precede a setext continuation with 4 spaces so it isn't a setext
      .replace(O_QUOTE_SETEXT, '\n    $1')
      .replace(O_QUOTE_MARKER, '');
    raw = raw ? `${raw}\n${chunkRaw}` : chunkRaw;
    text = text ? `${text}\n${chunkText}` : chunkText;

    const savedTop = ctx.top;
    ctx.top = true;
    scanBlocks(ctx, chunkText, tokens, true);
    ctx.top = savedTop;

    if (lines.length === 0) break;

    const lastTok = tokens[tokens.length - 1];
    if (lastTok !== undefined && (lastTok.t === 'code' || lastTok.t === 'heading' || lastTok.t === 'hr' || lastTok.t === 'html' || lastTok.t === 'table')) {
      // a continuation cannot follow those block types
      break;
    } else if (lastTok !== undefined && lastTok.t === 'blockquote') {
      // fold the continuation into the nested blockquote; it lives in the
      // same nesting frame, so strip one marker level from it too
      const continuation = lines.join('\n');
      const newText = lastTok.raw + '\n' + continuation.replace(O_QUOTE_MARKER, '');
      const newCap = P_BLOCKQUOTE.exec(newText);
      const newTok = blockquoteToken(ctx, newCap);
      tokens[tokens.length - 1] = newTok;

      // keep only the lines the nested quote actually consumed in raw
      const leftover = newText.substring(newTok.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) raw = `${raw}\n${consumed.join('\n')}`;
      text = text.substring(0, text.length - lastTok.text.length) + newTok.text;

      lines = lines.slice(consumed.length);
      if (lines.length > 0 && O_QUOTE_START.test(lines[0])) continue;
      break;
    } else if (lastTok !== undefined && lastTok.t === 'list') {
      const newText = lastTok.raw + '\n' + lines.join('\n');
      const newTok = listToken(ctx, newText);
      tokens[tokens.length - 1] = newTok;

      // the list raw carries no '>' markers: count the lines it took
      const consumedCount = newTok.raw.length > lastTok.raw.length
        ? newText.slice(lastTok.raw.length + 1, newTok.raw.length).split('\n').length
        : 0;
      if (consumedCount > 0) {
        const consumed = lines.slice(0, consumedCount).join('\n');
        raw = `${raw}\n${consumed}`;
        text = `${text}\n${consumed}`;
      }
      lines = lines.slice(consumedCount);
      continue;
    }
  }

  return { t: 'blockquote', raw, tokens, text };
}

// /\n[ \t]*\n[ \t]*$/ checked by hand from the end of the string.
function endsWithDoubleBlank(s) {
  let i = s.length;
  while (i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) i--;
  if (i === 0 || s[i - 1] !== '\n') return false;
  i--;
  while (i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) i--;
  return i > 0 && s[i - 1] === '\n';
}

// Index of the first character that is not a literal space, or -1.
// (marked's nonSpaceChar is /[^ ]/: tabs count as content.)
function firstNonSpace(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  return i === line.length ? -1 : i;
}

// The thematic-break begin pattern from offset s of a line: 3+ copies of
// the same -, _ or * marker, separated only by spaces/tabs, to the line end.
function hrLineAt(line, s) {
  const m = line[s];
  let count = 0;
  let i = s;
  while (i < line.length && line[i] === m) {
    count++;
    i++;
    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  }
  return count >= 3 && i === line.length;
}

// List: the outer pattern matches the first bullet; items are then carved
// out one at a time. An item keeps following lines while they are indented
// to its content column or read as lazy paragraph continuations. The walk
// is index-based over the list source so lines are only sliced when they
// are actually kept.
function listToken(ctx, src) {
  let cap = P_LIST.exec(src);
  if (!cap) return null;
  const listSrc = src;
  let pos = 0;
  const taken = () => pos;
  let bull = cap[1].trim();
  const ordered = bull.length > 1;
  const list = {
    t: 'list',
    raw: '',
    ordered,
    start: ordered ? +bull.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  bull = ordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
  const itemRegex = itemStickyFor(bull);
  let endsWithBlankLine = false;

  while (pos < listSrc.length) {
    let endEarly = false;
    let itemContents = '';
    itemRegex.lastIndex = pos;
    if (!(cap = itemRegex.exec(listSrc))) break;
    S_HR.lastIndex = pos;
    if (S_HR.test(listSrc)) break; // the bullet was actually a thematic break

    const itemStart = taken();
    pos += cap[0].length;

    const cap2 = cap[2];
    const cap2Nl = cap2.indexOf('\n');
    const firstLine = cap2Nl === -1 ? cap2 : cap2.slice(0, cap2Nl);
    const bulletIndent = cap[1].length;
    let line = (firstLine[0] === ' ' || firstLine[0] === '\t')
      ? firstLine.replace(O_LEADING_SPACE_TAB, (ws) => (ws.includes('\t') ? expandTabs(ws, bulletIndent) : ws))
      : firstLine;
    const firstNextEnd = listSrc.indexOf('\n', pos);
    let nextLine = listSrc.slice(pos, firstNextEnd === -1 ? listSrc.length : firstNextEnd);
    let blankLine = !line.trim();

    let indent = 0;
    if (blankLine) {
      indent = bulletIndent + 1;
    } else {
      indent = firstNonSpace(line); // first non-space char
      indent = indent > 4 ? 1 : indent; // deep indent counts as 1
      itemContents = line.slice(indent);
      indent += bulletIndent;
    }

    if (blankLine && O_BLANK_LINE.test(nextLine)) { // at most one blank line
      pos += nextLine.length + 1;
      endEarly = true;
    }

    if (!endEarly) {
      const hrS = hrPattern(indent);
      const fencesS = fencesBeginPattern(indent);
      const headingS = headingBeginPattern(indent);
      const htmlS = htmlBeginPattern(indent);
      // the begin patterns all open with ` {0,slot}` for this slot
      const slot = Math.max(0, Math.min(3, indent - 1));

      while (pos < listSrc.length) {
        const lineEnd = listSrc.indexOf('\n', pos);
        const rawLineEnd = lineEnd === -1 ? listSrc.length : lineEnd;
        const rawLine = listSrc.slice(pos, rawLineEnd);
        nextLine = rawLine;

        // Would a new block start on this line (fences / heading / html /
        // blockquote / next bullet / thematic break)? All six patterns are
        // ` {0,slot}` plus a marker, so a few char checks settle five of
        // them; only the html one needs its real pattern.
        let s = 0;
        while (s <= slot && rawLine[s] === ' ') s++;
        if (s <= slot) {
          const m = rawLine[s];
          if (m === '`' || m === '~') {
            if (rawLine[s + 1] === m && rawLine[s + 2] === m) break;
          } else if (m === '#') {
            let h = 1;
            while (rawLine[s + h] === '#') h++;
            if (h <= 6 && (s + h === rawLine.length || WS.test(rawLine[s + h]))) break;
          } else if (m === '>') {
            break;
          } else if (m === '*' || m === '-' || m === '+') {
            // a bullet (when the line ends or a space/tab follows it), or
            // a thematic break made of the same marker
            if (s + 1 === rawLine.length || rawLine[s + 1] === ' ' || rawLine[s + 1] === '\t') break;
            if (m !== '+' && hrLineAt(rawLine, s)) break;
          } else if (m === '<') {
            if (htmlS.test(rawLine)) break;
          } else if (m === '_') {
            if (hrLineAt(rawLine, s)) break;
          } else if (m >= '0' && m <= '9') {
            let d = 1;
            while (rawLine[s + d] >= '0' && rawLine[s + d] <= '9') d++;
            if (d <= 9 && (rawLine[s + d] === '.' || rawLine[s + d] === ')')
              && (s + d + 1 === rawLine.length || rawLine[s + d + 1] === ' ' || rawLine[s + d + 1] === '\t')) break;
          }
        }

        // expand tabs in the leading whitespace, but only when a tab is
        // actually there (a space-only run expands to itself)
        let lineNoTabs = rawLine;
        if (rawLine[0] === ' ' || rawLine[0] === '\t') {
          let e = 0;
          let hasTab = false;
          while (rawLine[e] === ' ' || rawLine[e] === '\t') {
            if (rawLine[e] === '\t') hasTab = true;
            e++;
          }
          if (hasTab) {
            lineNoTabs = rawLine.replace(O_LEADING_SPACE_TAB, (ws) => expandTabs(ws));
          }
        }

        const lineBlank = !nextLine.trim();
        let dedented = null;
        if (firstNonSpace(lineNoTabs) >= indent || lineBlank) {
          // dedent to the item's content column
          dedented = lineNoTabs.slice(indent);
          itemContents += '\n' + dedented;
        } else {
          if (blankLine) break;
          // the previous line being a different block level ends the item
          if (line.replace(O_TAB_G, '    ').search(O_NON_SPACE) >= 4) break;
          if (fencesS.test(line)) break;
          if (headingS.test(line)) break;
          if (htmlS.test(line)) break;
          if (hrS.test(line)) break;

          // a lazy continuation that looks like a setext underline stays in
          // the paragraph, re-indented so it can't become one
          const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine) && P_SETEXT.test(`${line}\n${nextLine}`);
          const continuation = setextContinuation
            ? `    ${lineNoTabs.replace(/^ {0,3}/, '')}`
            : nextLine;
          itemContents += '\n' + continuation;
        }

        blankLine = lineBlank;
        pos = rawLineEnd + 1;
        line = dedented !== null ? dedented : lineNoTabs.slice(indent);
      }
    }

    const raw = listSrc.slice(itemStart, taken());

    if (!list.loose) {
      // an item ending with a blank line makes the whole list loose
      if (endsWithBlankLine) list.loose = true;
      else if (endsWithDoubleBlank(raw)) endsWithBlankLine = true;
    }

    list.items.push({
      t: 'list_item',
      raw,
      task: O_TASK.test(itemContents),
      loose: false,
      text: itemContents,
      tokens: [],
    });
  }

  const lastItem = list.items[list.items.length - 1];
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else {
    return null; // no items: not a list
  }
  list.raw = listSrc.slice(0, taken()).trimEnd();

  // tokenize items first (this also settles looseness from spacer tokens),
  // then place task checkboxes against the final list.loose
  for (const item of list.items) {
    ctx.top = false;
    item.tokens = scanBlocks(ctx, item.text, []);
    if (!list.loose) {
      const spacers = item.tokens.filter((t) => t.t === 'space');
      list.loose = spacers.length > 0 && spacers.some((t) => O_ANY_LINE.test(t.raw));
    }
  }

  for (const item of list.items) {
    const first = item.tokens[0];
    if (item.task && first !== undefined && (first.t === 'text' || first.t === 'paragraph')) {
      item.text = item.text.replace(O_TASK_STRIP, '');
      first.raw = first.raw.replace(O_TASK_STRIP, '');
      first.text = first.text.replace(O_TASK_STRIP, '');
      for (let i = ctx.queue.length - 1; i >= 0; i--) {
        if (O_TASK.test(ctx.queue[i].src)) {
          ctx.queue[i].src = ctx.queue[i].src.replace(O_TASK_STRIP, '');
          break;
        }
      }
      const taskRaw = O_TASK_BOX.exec(item.raw);
      if (taskRaw) {
        const box = { t: 'checkbox', raw: taskRaw[0] + ' ', checked: taskRaw[0] !== '[ ]' };
        item.checked = box.checked;
        if (list.loose) {
          if (item.tokens[0] !== undefined && (item.tokens[0].t === 'paragraph' || item.tokens[0].t === 'text') && item.tokens[0].tokens) {
            item.tokens[0].raw = box.raw + item.tokens[0].raw;
            item.tokens[0].text = box.raw + item.tokens[0].text;
            item.tokens[0].tokens.unshift(box);
          } else {
            item.tokens.unshift({ t: 'paragraph', raw: box.raw, text: box.raw, tokens: [box] });
          }
        } else {
          item.tokens.unshift(box);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }

  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const token of item.tokens) {
        if (token.t === 'text') token.t = 'paragraph';
      }
    }
  }

  return list;
}

// ============================================================
// Inline phase
// ============================================================

const S_ESCAPE = stickyOf(P_ESCAPE);
const S_TAG = stickyOf(P_TAG);
const S_LINK = stickyOf(P_LINK);
const S_REFLINK = stickyOf(P_REFLINK);
const S_NOLINK = stickyOf(P_NOLINK);
const S_EM_L = stickyOf(P_EM_L);
const S_DEL_L = stickyOf(P_DEL_L);
const S_CODESPAN = stickyOf(P_CODESPAN);
const S_BR = stickyOf(P_BR);
const S_AUTOLINK = stickyOf(P_AUTOLINK);
const S_URL = stickyOf(P_URL);
const S_TEXT = stickyOf(P_TEXT);

const WS = /\s/;

const DELIM_RUNS = /(\*+|_+|~+)/g;
function scanClosers(src) {
  const last = { '*': -1, '_': -1, '~': -1 };
  DELIM_RUNS.lastIndex = 0;
  let m;
  while ((m = DELIM_RUNS.exec(src)) !== null) {
    const i = m.index;
    const prev = i === 0 ? '\n' : src[i - 1];
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      last[m[0][0]] = i;
    }
  }
  return last;
}

// Does this link text already hold a link? (An image does not count.)

const NO_CLOSERS = { '*': -1, '_': -1, '~': -1 };

// One inline run: tokenize `text` into `tokens`. Nested runs (link labels,
// emphasis content) save and restore the paren flag and the closer hints.

function linkInText(ctx, text) {
  if (!text.includes('[')) return false;
  for (const match of text.matchAll(P_BLOCK_SKIP)) {
    // blockSkip also matches code spans and html; an image's `!` sits just
    // before the match, so look at the character before it
    if (P_LINK.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }
  for (const match of text.matchAll(P_REFLINK_SEARCH)) {
    const m0 = match[0];
    const refStart = m0.lastIndexOf('[');
    if (m0.charAt(0) === '!' || !Object.hasOwn(ctx.links, normalizeLabel(m0.slice(refStart + 1, -1), ctx.labelCache))) {
      continue;
    }
    // a candidate holding a link is not itself a link either
    if (refStart > 1 && linkInText(ctx, m0.slice(1, refStart - 1))) continue;
    return true;
  }
  return false;
}

function maskReflink(ctx, m0) {
  const refStart = m0.lastIndexOf('[');
  if (!Object.hasOwn(ctx.links, normalizeLabel(m0.slice(refStart + 1, -1), ctx.labelCache))) {
    return m0;
  }
  // A candidate whose text already holds a link never becomes one, so mask
  // only the links it holds and leave its emphasis visible. Images exempt.
  if (refStart > 1 && m0.charAt(0) !== '!') {
    const text = m0.slice(1, refStart - 1);
    if (linkInText(ctx, text)) {
      return '[' + text.replace(P_REFLINK_SEARCH, (m) => maskReflink(ctx, m))
        + '][' + 'a'.repeat(m0.length - refStart - 2) + ']';
    }
  }
  return '[' + 'a'.repeat(m0.length - 2) + ']';
}

// Build the masked twin of an inline run: same length, but with link
// brackets, escapes, code spans and html neutralised so the emphasis scans
// don't see delimiters inside them.

const O_MASK_INTEREST = /[\\`[<]/;
function maskSource(ctx, src) {
  // one scan decides whether any masking step can change anything at all
  if (!O_MASK_INTEREST.test(src)) return src;
  let masked = src;
  // With no link definitions anywhere, every reflink candidate is returned
  // unchanged by the mask, so the whole pass is the identity.
  if (ctx.hasLinks && src.includes('[')) {
    masked = masked.replace(P_REFLINK_SEARCH, (m) => maskReflink(ctx, m));
  }
  // The escape/code-span mask is the identity when the run holds neither a
  // backslash nor a backtick (its only matches start with one of those).
  if (src.includes('\\') || src.includes('`')) {
    masked = masked.replace(P_ANY_PUNCT_OUTSIDE_CODE, (m0, code, punct) => {
      if (punct) return '+'.repeat(m0.length);
      if (code) return code + m0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      return m0;
    });
  }
  // blockSkip matches only links, code spans and html: without '[', '`' or
  // '<' in the run it is the identity too.
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    masked = masked.replace(P_BLOCK_SKIP, (m0, _link, context) => {
      const offset = context ? context.length : 0;
      return m0.slice(0, offset) + '[' + 'a'.repeat(m0.length - offset - 2) + ']';
    });
  }
  return masked;
}

// A link label containing `<` is rejected when a tag or autolink starting
// inside the label would end past the label's end.

function isLabelEndInsideToken(text, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const code = P_CODESPAN.exec(label.slice(i));
      if (code) { i += code[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = text.slice(labelStart + i);
    const token = P_TAG.exec(tokenSrc) || P_AUTOLINK.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

// Shared tail of the link and reflink tokenizers: tokenize the label, and
// (for links) bail entirely when the label itself emitted a link.

function outputLink(ctx, cap, link, raw) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].includes('\\') ? cap[1].replace(O_OUTPUT_LINK_REPLACE, '$1') : cap[1];
  const isImage = cap[0].charAt(0) === '!';

  const outerInLink = ctx.inLink;
  const outerEmitted = ctx.linkEmitted;
  const outerRaw = ctx.inRawBlock;
  ctx.inLink = true;
  ctx.linkEmitted = false;
  const tokens = scanInline(ctx, text, []);
  const hasLink = ctx.linkEmitted;
  ctx.linkEmitted = outerEmitted;
  ctx.inLink = outerInLink;

  if (!isImage) {
    if (hasLink) {
      // the discarded tokens may have opened a raw block; undo that
      ctx.inRawBlock = outerRaw;
      return null;
    }
    ctx.linkEmitted = true;
  }
  return { t: isImage ? 'image' : 'link', raw, href, title, text, tokens };
}

function linkAt(ctx, text, pos) {
  // with no ')' anywhere ahead the link pattern cannot match
  if (ctx.parenPossible === false) return null;
  const cap = (S_LINK.lastIndex = pos, S_LINK.exec(text));
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(text, cap[1], pos + labelStart)) return null;

  const trimmedUrl = cap[2].trim();
  if (O_START_ANGLE.test(trimmedUrl)) {
    // angle-bracket destinations need their closing bracket, unescaped
    if (!O_END_ANGLE.test(trimmedUrl)) return null;
    const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return null;
  } else {
    const lastParenIndex = findClosingBracket(cap[2], '()');
    if (lastParenIndex === -2) return null; // more opens than closes
    if (lastParenIndex > -1) {
      const start = cap[0].indexOf('!') === 0 ? 5 : 4;
      const linkLen = start + cap[1].length + lastParenIndex;
      cap[2] = cap[2].substring(0, lastParenIndex);
      cap[0] = cap[0].substring(0, linkLen).trim();
      cap[3] = '';
    }
  }
  // the closer itself must not be escaped
  const unescaped = rtrim(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - unescaped.length) % 2 === 0) return null;

  let href = cap[2];
  const title = cap[3] ? cap[3].slice(1, -1) : '';
  href = href.trim();
  if (O_START_ANGLE.test(href)) href = href.slice(1, -1);
  return outputLink(ctx, cap, {
    href: href && href.includes('\\') ? href.replace(P_ANY_PUNCT, '$1') : href,
    title: title && title.includes('\\') ? title.replace(P_ANY_PUNCT, '$1') : title,
  }, cap[0]);
}

function reflinkAt(ctx, text, pos) {
  const cap = (S_REFLINK.lastIndex = pos, S_REFLINK.exec(text)) || (S_NOLINK.lastIndex = pos, S_NOLINK.exec(text));
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(text, cap[1], pos + labelStart)) return null;
  const link = ctx.links[normalizeLabel(cap[2] || cap[1], ctx.labelCache)];
  if (!link) {
    // not a link: the bracket itself becomes literal text
    const first = cap[0].charAt(0);
    return { t: 'text', raw: first, text: first };
  }
  return outputLink(ctx, cap, link, cap[0]);
}

function emStrongAt(ctx, text, masked, pos, prevChar) {
  // Cheap outs the L pattern would also produce: no group can be set when
  // the delimiter run is followed by whitespace or the end of the string,
  // and an underscore run after an alphanumeric whose next character is not
  // punctuation hits the intra-word rejection below.
  const dc = text[pos];
  let runEnd = pos + 1;
  while (text[runEnd] === dc) runEnd++;
  const nxt = text[runEnd];
  if (nxt === undefined || WS.test(nxt)) return null;
  if (dc === '_' && prevChar !== '' && O_ALNUM.test(prevChar) && !P_PUNCTUATION.test(nxt)) return null;
  let match = (S_EM_L.lastIndex = pos, S_EM_L.exec(text));
  if (!match) return null;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return null;

  const delimChar = match[0][0];
  // a mid-run opener must only pair with a delimiter that can only close
  const midRun = prevChar === delimChar;

  // the run may start behind the cursor (part of it already consumed);
  // flanking and rules 9-10 are about the whole run
  let runStart = pos;
  while (runStart > 0 && masked[runStart - 1] === delimChar) runStart--;
  const runPrevChar = [...masked.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  // the other delimiter character counts as punctuation here
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!P_PUNCTUATION.exec(runPrevChar);
  if (runStart < pos) prevChar = runPrevChar;
  const prevPunct = runStart < pos ? runPrevPunct : !!P_PUNCTUATION.exec(prevChar);

  // _ can't sit between two alphanumerics
  if (match[4] && prevChar.match(O_ALNUM)) return null;

  const nextChar = match[1] || match[3] || '';
  if (!nextChar || !prevChar || prevPunct) {
    const lLength = [...match[0]].length - 1;
    let rDelim;
    let rLength;
    let delimTotal = lLength;
    let midDelimTotal = 0;

    const runLength = pos - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim()
      && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return null;
    const endReg = delimChar === '*' ? P_EM_R_AST : P_EM_R_UND;
    const windowStart = pos + lLength;
    if (ctx.hints[delimChar] < windowStart) return null; // no closer exists
    const clipped = masked.slice(windowStart);
    const lastInWindow = ctx.hints[delimChar] - windowStart;
    endReg.lastIndex = 0;

    while ((match = endReg.exec(clipped)) !== null) {
      if (match.index > lastInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue; // skip a lone * in __abc*abc__
      rLength = [...rDelim].length;

      if (match[3] || match[4]) { // another left delimiter
        delimTotal += rLength;
        continue;
      } else if (match[5] || match[6] || openerCanClose) { // left or right delim
        if (midRun && (match[5] || match[6])) break;
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue; // CommonMark rules 9-10
        }
      }

      delimTotal -= rLength;
      if (delimTotal > 0) continue; // not enough closing delimiters yet

      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = text.slice(pos, pos + lLength + match.index + lastCharLength + rLength);

      if (Math.min(lLength, rLength) % 2) {
        const inner = raw.slice(1, -1);
        return { t: 'em', raw, text: inner, tokens: scanInline(ctx, inner, []) };
      }
      const inner = raw.slice(2, -2);
      return { t: 'strong', raw, text: inner, tokens: scanInline(ctx, inner, []) };
    }
  }
  return null;
}

function delAt(ctx, text, masked, pos, prevChar) {
  let match = (S_DEL_L.lastIndex = pos, S_DEL_L.exec(text));
  if (!match) return null;
  const nextChar = match[1] || '';
  if (!nextChar || !prevChar || P_PUNCTUATION.exec(prevChar)) {
    const lLength = [...match[0]].length - 1;
    let rDelim;
    let rLength;
    let delimTotal = lLength;
    const windowStart = pos + lLength;
    if (ctx.hints['~'] < windowStart) return null;
    const clipped = masked.slice(windowStart);
    const lastInWindow = ctx.hints['~'] - windowStart;
    P_DEL_R.lastIndex = 0;

    while ((match = P_DEL_R.exec(clipped)) !== null) {
      if (match.index > lastInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = [...rDelim].length;
      if (rLength !== lLength) continue;
      if (match[3] || match[4]) { // another left delimiter
        delimTotal += rLength;
        continue;
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = text.slice(pos, pos + lLength + match.index + lastCharLength + rLength);
      const inner = raw.slice(lLength, -lLength);
      return { t: 'del', raw, text: inner, tokens: scanInline(ctx, inner, []) };
    }
  }
  return null;
}

function urlAt(ctx, text, pos) {
  if (!urlGateAt(text, pos)) return null;
  const cap = (S_URL.lastIndex = pos, S_URL.exec(text));
  if (!cap) return null;
  let txt;
  let href;
  if (cap[2] === '@') {
    txt = cap[0];
    href = 'mailto:' + txt;
  } else {
    // trim trailing punctuation / unbalanced closers, repeatedly
    let prev;
    do {
      prev = cap[0];
      cap[0] = P_BACKPEDAL.exec(cap[0])?.[0] ?? '';
    } while (prev !== cap[0]);
    txt = cap[0];
    href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
  }
  return { t: 'link', raw: cap[0], text: txt, href, autolink: true, tokens: [{ t: 'text', raw: txt, text: txt }] };
}

// ---- plain-text runs and the url gate -------------------------------------
// The text pattern's match length, computed without running the pattern:
// its body is a lazy scan that stops at the first "event" — a delimiter
// character, a hard break, an http/https or ftp:// word, a www. prefix
// after whitespace or `*_~(`, a mailto:/xmpp: word after a non-alphanumeric,
// or the start of an email run that ends at an `@`. One global pattern
// finds the candidate events natively; the checks below decide each.

const TEXT_EVENTS = /[\\<!\[`*~_]| {2,}\n|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|www\.|mailto:|xmpp:/g;

function isAlnumCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

const EMAIL_CHAR_OK = (() => {
  const t = new Uint8Array(128);
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+/=?^_`{|}~-";
  for (let i = 0; i < chars.length; i++) t[chars.charCodeAt(i)] = 1;
  return t;
})();

function isEmailCharAt(S, i) {
  const c = S.charCodeAt(i);
  return c < 128 && EMAIL_CHAR_OK[c] === 1;
}

function mailtoWordAt(S, p) {
  return S.startsWith('mailto:', p) || S.startsWith('xmpp:', p);
}

// A full protocol:// prefix (http, https or ftp), as the url rule requires.
function protocolFullAt(S, p) {
  const a = S.charCodeAt(p);
  const b = S.charCodeAt(p + 1);
  const c = S.charCodeAt(p + 2);
  const d = S.charCodeAt(p + 3);
  if ((a === 104 || a === 72) && (b === 116 || b === 84) && (c === 116 || c === 84) && (d === 112 || d === 80)) {
    let q = p + 4;
    if (S[q] === 's' || S[q] === 'S') q++;
    return S[q] === ':' && S[q + 1] === '/' && S[q + 2] === '/';
  }
  if ((a === 102 || a === 70) && (b === 116 || b === 84) && (c === 112 || c === 80)) {
    return S[p + 3] === ':' && S[p + 4] === '/' && S[p + 5] === '/';
  }
  return false;
}

// Length of the plain-text token starting at pos (always at least 1).
function scanTextRun(S, pos) {
  const n = S.length;
  // a lone character when a mailto:/xmpp: word follows a non-alphanumeric
  if (!isAlnumCode(S.charCodeAt(pos)) && mailtoWordAt(S, pos + 1)) {
    return 1;
  }
  let head;
  const ch = S[pos];
  if (ch === '`' || ch === '~') {
    let q = pos + 1;
    while (S[q] === ch) q++;
    head = q - pos;
  } else {
    head = 1;
  }
  const start = pos + head;
  if (start >= n) return head;

  // the email end, if any: the first `@` past start whose preceding run of
  // email characters is non-empty ends the token where that run starts
  // (clamped to start, for a run that began inside the head)
  let emailEnd = n;
  for (let a = S.indexOf('@', start); a !== -1; a = S.indexOf('@', a + 1)) {
    if (a === start) continue;
    let r = a;
    while (r > 0 && isEmailCharAt(S, r - 1)) r--;
    if (r < a) {
      emailEnd = Math.max(start, r);
      break;
    }
  }

  TEXT_EVENTS.lastIndex = start;
  let m;
  while ((m = TEXT_EVENTS.exec(S)) !== null) {
    const q = m.index;
    if (q >= emailEnd) return emailEnd - pos;
    const m0 = m[0];
    if (m0.length === 1) return q - pos; // a delimiter character
    if (m0.charCodeAt(0) === 32) return q - pos; // a hard break's space run
    if (m0 === 'www.') {
      // only after whitespace or one of *_~(
      const prev = S[q - 1];
      if (prev === '*' || prev === '_' || prev === '~' || prev === '(' || WS.test(prev)) {
        return q - pos;
      }
      TEXT_EVENTS.lastIndex = q + 1;
      continue;
    }
    if (m0 === 'mailto:' || m0 === 'xmpp:') {
      // the token takes the character before the word, then stops — that
      // character must be a body character (past the head) and non-alnum
      if (q > start && !isAlnumCode(S.charCodeAt(q - 1))) {
        return q - pos;
      }
      TEXT_EVENTS.lastIndex = q + 1;
      continue;
    }
    // an http/https word or an ftp:// prefix: the token stops before it
    return q - pos;
  }
  return emailEnd - pos;
}

// Whether the url pattern could match at pos at all: a www. prefix, a
// mailto:/xmpp: word, a full protocol:// prefix, or an email address.
function urlGateAt(S, pos) {
  const c = S[pos];
  if (c === 'w' && S.startsWith('www.', pos)) return true;
  if (c === 'm' && S.startsWith('mailto:', pos)) return true;
  if (c === 'x' && S.startsWith('xmpp:', pos)) return true;
  if ((c === 'h' || c === 'H' || c === 'f' || c === 'F') && protocolFullAt(S, pos)) return true;
  const code = S.charCodeAt(pos);
  if (!isAlnumCode(code) && c !== '.' && c !== '_' && c !== '+' && c !== '-') return false;
  let q = pos;
  while (q < S.length) {
    const cc = S.charCodeAt(q);
    if (!isAlnumCode(cc) && S[q] !== '.' && S[q] !== '_' && S[q] !== '+' && S[q] !== '-') break;
    q++;
  }
  return S[q] === '@';
}

function scanInline(ctx, text, tokens) {
  const prevParen = ctx.parenPossible;
  ctx.parenPossible = prevParen && text.includes(')');
  const savedHints = ctx.hints;
  let masked;
  // Without a *, _ or ~ anywhere, masking is the identity and no emphasis
  // or strikethrough opener can occur, so the closer hints are all -1.
  if (!/[*_~]/.test(text)) {
    masked = text;
    ctx.hints = NO_CLOSERS;
  } else {
    masked = maskSource(ctx, text);
    ctx.hints = scanClosers(masked);
  }
  try {
  let pos = 0;
  const end = text.length;
  let prevChar = '';
  let keepPrev = false;

  while (pos < end) {
    if (!keepPrev) prevChar = '';
    keepPrev = false;
    const ch = text[pos];
    let cap;
    let tok;

    // escape
    if (ch === '\\' && (cap = (S_ESCAPE.lastIndex = pos, S_ESCAPE.exec(text)))) {
      tokens.push({ t: 'escape', raw: cap[0], text: cap[1] });
      pos += cap[0].length;
      continue;
    }

    // html tag / comment
    if (ch === '<' && (cap = (S_TAG.lastIndex = pos, S_TAG.exec(text)))) {
      if (!ctx.inLink && O_START_A.test(cap[0])) ctx.inLink = true;
      else if (ctx.inLink && O_END_A.test(cap[0])) ctx.inLink = false;
      if (!ctx.inRawBlock && O_START_PRE.test(cap[0])) ctx.inRawBlock = true;
      else if (ctx.inRawBlock && O_END_PRE.test(cap[0])) ctx.inRawBlock = false;
      tokens.push({ t: 'html', raw: cap[0], inLink: ctx.inLink, inRawBlock: ctx.inRawBlock, text: cap[0] });
      pos += cap[0].length;
      continue;
    }

    // inline link / image
    if ((ch === '[' || ch === '!') && (tok = linkAt(ctx, text, pos))) {
      tokens.push(tok);
      pos += tok.raw.length;
      continue;
    }

    // reference link / shortcut reference
    if ((ch === '[' || ch === '!') && (tok = reflinkAt(ctx, text, pos))) {
      const lastTok = tokens[tokens.length - 1];
      if (tok.t === 'text' && lastTok !== undefined && lastTok.t === 'text') {
        lastTok.raw += tok.raw;
        lastTok.text += tok.text;
      } else {
        tokens.push(tok);
      }
      pos += tok.raw.length;
      continue;
    }

    // emphasis / strong
    if ((ch === '*' || ch === '_') && (tok = emStrongAt(ctx, text, masked, pos, prevChar))) {
      tokens.push(tok);
      pos += tok.raw.length;
      continue;
    }

    // code span
    if (ch === '`' && (cap = (S_CODESPAN.lastIndex = pos, S_CODESPAN.exec(text)))) {
      let txt = cap[2].replace(O_NEWLINE_G, ' ');
      if (O_NON_SPACE.test(txt) && O_STARTING_SPACE.test(txt) && O_ENDING_SPACE.test(txt)) {
        txt = txt.substring(1, txt.length - 1);
      }
      tokens.push({ t: 'codespan', raw: cap[0], text: txt });
      pos += cap[0].length;
      continue;
    }

    // hard break
    if ((ch === ' ' || ch === '\\') && (cap = (S_BR.lastIndex = pos, S_BR.exec(text)))) {
      tokens.push({ t: 'br', raw: cap[0] });
      pos += cap[0].length;
      continue;
    }

    // strikethrough
    if (ch === '~' && (tok = delAt(ctx, text, masked, pos, prevChar))) {
      tokens.push(tok);
      pos += tok.raw.length;
      continue;
    }

    // autolink in angle brackets
    if (ch === '<' && (cap = (S_AUTOLINK.lastIndex = pos, S_AUTOLINK.exec(text)))) {
      const txt = cap[1];
      const href = cap[2] === '@' ? 'mailto:' + txt : txt;
      tokens.push({ t: 'link', raw: cap[0], text: txt, href, autolink: true, tokens: [{ t: 'text', raw: txt, text: txt }] });
      pos += cap[0].length;
      continue;
    }

    // bare url / email (only outside links)
    if (!ctx.inLink
      && ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9')
        || ch === '.' || ch === '_' || ch === '+' || ch === '-')
      && (tok = urlAt(ctx, text, pos))) {
      tokens.push(tok);
      pos += tok.raw.length;
      continue;
    }

    // plain text (the scanner computes the run the text pattern would take)
    {
      const len = scanTextRun(text, pos);
      const rawText = text.slice(pos, pos + len);
      const escaped = ctx.inRawBlock;
      if (rawText.charAt(rawText.length - 1) !== '_') prevChar = rawText.charAt(rawText.length - 1);
      keepPrev = true;
      const lastTok = tokens[tokens.length - 1];
      if (lastTok !== undefined && lastTok.t === 'text') {
        lastTok.raw += rawText;
        lastTok.text += escaped ? rawText : decodeNumericRefs(rawText);
      } else {
        tokens.push({ t: 'text', raw: rawText, text: escaped ? rawText : decodeNumericRefs(rawText), escaped });
      }
      pos += len;
      continue;
    }

    break; // unreachable: the text pattern always matches
  }
  return tokens;  } finally {
    ctx.hints = savedHints;
    ctx.parenPossible = prevParen;
  }
  return tokens;
}

// ============================================================
// Rendering
// ============================================================

function renderTextToken(tok) {
  if (tok.tokens) return renderInline(tok.tokens);
  return tok.escaped ? tok.text : escapeHtmlEntities(tok.text);
}

function renderLink(tok) {
  const parsedText = tok.autolink ? escapeHtmlEntities(tok.text, true) : renderInline(tok.tokens);
  const clean = cleanUrl(tok.href);
  if (clean === null) return parsedText;
  let out = '<a href="' + escapeHtmlEntities(clean, tok.autolink) + '"';
  if (tok.title) out += ' title="' + escapeHtmlEntities(tok.title) + '"';
  return out + '>' + parsedText + '</a>';
}

function renderImage(tok) {
  const text = tok.tokens ? renderTextOnly(tok.tokens) : tok.text;
  const clean = cleanUrl(tok.href);
  if (clean === null) return escapeHtmlEntities(text);
  let out = `<img src="${escapeHtmlEntities(clean)}" alt="${escapeHtmlEntities(text)}"`;
  if (tok.title) out += ` title="${escapeHtmlEntities(tok.title)}"`;
  return out + '>';
}

// The text-only renderer used for image alt text: formatting collapses to
// the text it wraps, code spans and html stay literal, breaks vanish.
function renderTextOnly(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.t) {
      case 'strong':
      case 'em':
      case 'del':
      case 'link':
      case 'image':
        out += tok.tokens ? renderTextOnly(tok.tokens) : tok.text;
        break;
      case 'codespan':
      case 'html':
      case 'text':
      case 'escape':
        out += tok.text;
        break;
      case 'checkbox':
        out += tok.raw;
        break;
      case 'br':
        break;
      default:
        break;
    }
  }
  return out;
}

function renderInline(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.t) {
      case 'escape': out += renderTextToken(tok); break;
      case 'html': out += tok.text; break;
      case 'link': out += renderLink(tok); break;
      case 'image': out += renderImage(tok); break;
      case 'checkbox': out += renderCheckbox(tok); break;
      case 'strong': out += `<strong>${renderInline(tok.tokens)}</strong>`; break;
      case 'em': out += `<em>${renderInline(tok.tokens)}</em>`; break;
      case 'codespan': out += `<code>${escapeHtmlEntities(tok.text, true)}</code>`; break;
      case 'br': out += '<br>'; break;
      case 'del': out += `<del>${renderInline(tok.tokens)}</del>`; break;
      case 'text': out += renderTextToken(tok); break;
      default: break;
    }
  }
  return out;
}

function renderCheckbox(tok) {
  return '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function renderTable(tok) {
  let header = '';
  let cell = '';
  for (const c of tok.header) cell += renderCell(c);
  header += `<tr>\n${cell}</tr>\n`;
  let body = '';
  for (const row of tok.rows) {
    cell = '';
    for (const c of row) cell += renderCell(c);
    body += `<tr>\n${cell}</tr>\n`;
  }
  if (body) body = `<tbody>${body}</tbody>`;
  return '<table>\n<thead>\n' + header + '</thead>\n' + body + '</table>\n';
}

function renderCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  const open = cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`;
  return open + renderInline(cell.tokens) + `</${tag}>\n`;
}

function renderBlocks(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.t) {
      case 'space':
      case 'def':
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'heading':
        out += `<h${tok.depth}>${renderInline(tok.tokens)}</h${tok.depth}>\n`;
        break;
      case 'code': {
        const langString = (tok.lang || '').match(O_NOT_SPACE_START)?.[0];
        const code = tok.text ? tok.text.replace(O_ENDING_NL, '') + '\n' : '';
        const body = escapeHtmlEntities(code, true);
        out += langString
          ? `<pre><code class="language-${escapeHtmlEntities(langString)}">${body}</code></pre>\n`
          : `<pre><code>${body}</code></pre>\n`;
        break;
      }
      case 'table':
        out += renderTable(tok);
        break;
      case 'blockquote':
        out += `<blockquote>\n${renderBlocks(tok.tokens)}</blockquote>\n`;
        break;
      case 'list': {
        let body = '';
        for (const item of tok.items) body += `<li>${renderBlocks(item.tokens)}</li>\n`;
        const type = tok.ordered ? 'ol' : 'ul';
        const startAttr = tok.ordered && tok.start !== 1 ? ` start="${tok.start}"` : '';
        out += `<${type}${startAttr}>\n${body}</${type}>\n`;
        break;
      }
      case 'checkbox':
        out += renderCheckbox(tok);
        break;
      case 'html':
        out += tok.text;
        break;
      case 'paragraph':
        out += `<p>${renderInline(tok.tokens)}</p>\n`;
        break;
      case 'text':
        out += renderTextToken(tok);
        break;
      default:
        break;
    }
  }
  return out;
}

// ============================================================
// Entry point
// ============================================================

export function parse(markdown) {
  const ctx = newParseCtx();
  const src = markdown.includes('\r') ? markdown.replace(O_CR, '\n') : markdown;
  const tokens = scanBlocks(ctx, src, []);
  // inline jobs run after the whole block tree exists, in creation order;
  // a raw block opened by an inline tag ends with the block holding it
  for (let i = 0; i < ctx.queue.length; i++) {
    ctx.inRawBlock = false;
    scanInline(ctx, ctx.queue[i].src, ctx.queue[i].tokens);
  }
  return renderBlocks(tokens);
}
