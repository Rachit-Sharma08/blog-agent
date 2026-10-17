/**
 * blog-agent/generate-draft.mjs
 *
 * Generates ONE new blog-post draft for this portfolio's blog and, only when
 * run with --save, inserts it into Supabase as an unpublished row.
 *
 * Deliberate constraints:
 *   - No dependencies: plain Node `fetch` talks to Supabase PostgREST, the
 *     Gemini API and OpenRouter directly.
 *   - Default mode is a DRY RUN - the draft is printed, nothing is written.
 *     --save always inserts with published=false and published_at=null; it
 *     never flips them. Publishing stays a human decision in /admin.
 *   - This script never calls the rebuild/deploy hook. That hook belongs to
 *     the admin publish flow, not to draft generation.
 *
 * The `content` column is GitHub-flavoured Markdown: supabase/seed.sql stores
 * blank-line separated paragraphs there, and src/pages/BlogPost.tsx renders
 * the column through renderMarkdown() into the `.rich-text` styles. New posts
 * also follow the blog-writing rules in AGENTS.md (T4d): every "## " heading
 * is a question, answered directly in the first sentence or two, then detail.
 *
 * Usage:
 *   node blog-agent/generate-draft.mjs                            # dry run
 *   node blog-agent/generate-draft.mjs --save                     # insert draft
 *   node --env-file=blog-agent/.env blog-agent/generate-draft.mjs --save
 *
 * Env (see blog-agent/.env.example): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * GEMINI_API_KEY, GEMINI_MODEL, OPENROUTER_API_KEY, OPENROUTER_MODEL (defaults
 * to "openrouter/free"). A missing required variable is reported by name only;
 * secret values are never printed anywhere.
 */

const SAVE = process.argv.includes('--save')

const REQUIRED_ENV = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'GEMINI_API_KEY',
  'GEMINI_MODEL',
  'OPENROUTER_API_KEY',
]

const RECENT_WINDOW_DAYS = 28
const DAY_MS = 24 * 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 60_000

class ProviderHttpError extends Error {
  constructor(status) {
    super(`HTTP ${status}`)
    this.status = status
  }
}

class InvalidOutputError extends Error {}

function fail(message) {
  console.error(message)
  process.exit(1)
}

function describeFailure(error) {
  if (error instanceof ProviderHttpError) return `HTTP ${error.status}`
  if (error?.name === 'TimeoutError') return 'request timed out'
  if (error instanceof TypeError) return 'network error'
  return error?.message || 'unknown error'
}

/**
 * Read the environment. The values are only ever used to talk to the three
 * APIs - they are never logged, never echoed into errors, never written out.
 */
function readEnv() {
  const missing = REQUIRED_ENV.filter((name) => !String(process.env[name] ?? '').trim())
  if (missing.length > 0) {
    fail(`Missing required environment variable(s): ${missing.join(', ')}`)
  }
  return {
    supabaseUrl: String(process.env.SUPABASE_URL).trim().replace(/\/+$/, ''),
    supabaseServiceKey: String(process.env.SUPABASE_SERVICE_ROLE_KEY).trim(),
    geminiKey: String(process.env.GEMINI_API_KEY).trim(),
    geminiModel: String(process.env.GEMINI_MODEL).trim(),
    openRouterKey: String(process.env.OPENROUTER_API_KEY).trim(),
    openRouterModel: String(process.env.OPENROUTER_MODEL ?? '').trim() || 'openrouter/free',
  }
}

function supabaseHeaders(env) {
  return {
    apikey: env.supabaseServiceKey,
    Authorization: `Bearer ${env.supabaseServiceKey}`,
    Accept: 'application/json',
  }
}

/** All rows, exactly the four fields the topic lists need. PostgREST REST. */
async function fetchPosts(env) {
  const url = `${env.supabaseUrl}/rest/v1/blog_posts?select=title,category,created_at,published_at`
  const response = await fetch(url, {
    headers: supabaseHeaders(env),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) fail(`Could not read blog_posts from Supabase (HTTP ${response.status}).`)
  const rows = await response.json()
  if (!Array.isArray(rows)) fail('Supabase returned an unexpected payload for blog_posts.')
  return rows
}

/**
 * Topics to avoid, straight from the fetched rows:
 *   - `existing` - every post title + category, the do-not-repeat list.
 *   - `recent`   - posts inside the last RECENT_WINDOW_DAYS days, measured on
 *                  published_at (created_at when the post was never published).
 *                  These go to the AI as strictly forbidden.
 *   - An unparseable date is not treated as recent.
 */
function buildTopicLists(rows) {
  const cutoff = Date.now() - RECENT_WINDOW_DAYS * DAY_MS
  const existing = []
  const recent = []

  for (const row of rows) {
    const title = String(row?.title ?? '').trim()
    const category = String(row?.category ?? '').trim()
    if (!title && !category) continue

    let label
    if (title && category) label = `"${title}" (category: ${category})`
    else if (title) label = `"${title}"`
    else label = `(category: ${category})`

    if (!existing.includes(label)) existing.push(label)

    const stamp = row?.published_at || row?.created_at
    const time = Date.parse(String(stamp ?? ''))
    if (Number.isFinite(time) && time >= cutoff && !recent.includes(label)) recent.push(label)
  }

  return { existing, recent }
}

function bulletList(items) {
  if (items.length === 0) return '(none)'
  return items.map((item, index) => `${index + 1}. ${item}`).join('\n')
}

/**
 * The one prompt both providers get. The format rules mirror how the site
 * stores posts (supabase/seed.sql) and renders them (BlogPost.tsx ->
 * renderMarkdown() -> `.rich-text`).
 */
function buildPrompt({ existing, recent }) {
  return `You are writing one new draft for the personal blog of Rachit Sharma, a digital marketer from Kaithal, Haryana, India who works hands-on with AI tools. The blog's beat is digital marketing and AI work.

Voice: first person, calm and concrete - specific process, honest trade-offs. No hype, no filler ("in today's fast-paced world"), no keyword stuffing. Short paragraphs.

FACTUAL HONESTY - these posts are published under a real person's name, so nothing may be made up:
  - Never invent clients, companies, case studies, personal experiences, past events, quotes or results. Never write sentences like "last year I...", "a client of mine...", "when we did this for...".
  - First person is allowed ONLY for opinions and the recommended approach (for example "I would start with...", "I would look at..."), never to claim past experience, delivered work or results.
  - No specific statistics, percentages, prices or study results unless they are widely known facts, and then stated cautiously ("studies often find...", "in most cases...").
  - Example arithmetic is allowed only when it is clearly hypothetical and uses round numbers (for example "say you spend 5,000 rupees a month on ads..."), and must read as an example, never as a measured result.
  - If you do not know a fact, describe the approach or say that it depends - never fill the gap with a number or a story.

Existing posts - every title and category is already covered. The new topic must not be the same as, or similar to, any of these:
${bulletList(existing)}

STRICTLY FORBIDDEN - these posts are from the last ${RECENT_WINDOW_DAYS} days, so their topics, angles and categories are completely off-limits; nothing same or similar:
${bulletList(recent)}

Pick ONE new topic that is clearly different from everything above.

Return ONLY a valid JSON object - no markdown fences, no commentary before or after - with exactly these string fields:
  "title":    specific and concrete, at most 60 characters, no clickbait.
  "slug":     lowercase kebab-case ASCII, e.g. "why-ad-copy-stops-working".
  "excerpt":  ONE sentence, at most about 155 characters. It is shown as the standfirst and used as the meta description.
  "category": a short label in the style of the existing categories (e.g. "SEO", "Branding", "Copywriting", "AI \u00b7 Prompting").
  "content":  the post body as GitHub-flavoured Markdown, in this exact shape:
              - Blank line between every block; each paragraph is a single line (do not hard-wrap).
              - 2-4 sections, each starting with a question-style "## " heading, e.g. "## What makes a hook work?".
              - Immediately after each heading, answer it in 1-2 complete sentences that name their subject, then add the detail. Answer first, detail after.
              - Markdown only - raw HTML is escaped and shown as literal text.
              - Roughly 500-800 words in total.

Respond with the JSON object only.`
}

/** Strip markdown fences, then slice the outermost {...} out of the response. */
function extractJsonObject(text) {
  let value = String(text ?? '').trim()
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) value = fenced[1].trim()
  const start = value.indexOf('{')
  const end = value.lastIndexOf('}')
  if (start === -1 || end <= start) throw new InvalidOutputError('no JSON object found in the response')
  return value.slice(start, end + 1)
}

function normalizeSlug(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** All five fields must be present, non-empty strings; the slug is normalised. */
function validateDraft(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidOutputError('the response was not a JSON object')
  }
  const draft = {
    title: typeof value.title === 'string' ? value.title.trim() : '',
    slug: normalizeSlug(value.slug),
    excerpt: typeof value.excerpt === 'string' ? value.excerpt.trim() : '',
    category: typeof value.category === 'string' ? value.category.trim() : '',
    content: typeof value.content === 'string' ? value.content.trim() : '',
  }
  const missing = Object.keys(draft).filter((key) => !draft[key])
  if (missing.length > 0) throw new InvalidOutputError(`missing or empty field(s): ${missing.join(', ')}`)
  return draft
}

function parseDraft(rawText) {
  let parsed
  try {
    parsed = JSON.parse(extractJsonObject(rawText))
  } catch (error) {
    if (error instanceof InvalidOutputError) throw error
    throw new InvalidOutputError('the response was not valid JSON')
  }
  return validateDraft(parsed)
}

/**
 * One attempt plus one retry. The retry is only for invalid output - an HTTP
 * or network failure throws straight through so the caller can fall back to
 * the next provider.
 */
async function generateDraftRequest(providerName, request) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const rawText = await request()
      return parseDraft(rawText)
    } catch (error) {
      if (!(error instanceof InvalidOutputError)) throw error
      console.log(`${providerName}: invalid output on attempt ${attempt} (${error.message}).`)
      if (attempt === 1) console.log(`${providerName}: retrying once.`)
      else throw new InvalidOutputError('invalid output after the retry')
    }
  }
}

/**
 * Providers may split one answer into several text parts. Joining them with an
 * empty string can fuse the last word of one part with the first word of the
 * next ("leads" + "acquired" -> "leadsacquired"), so a part boundary that has
 * no whitespace on either side gets a single space. Whitespace at the
 * boundary - including a newline - is kept as it is, never deleted.
 */
function joinTextParts(parts) {
  return parts.reduce((text, part) => {
    if (!text || /\s$/.test(text) || /^\s/.test(part)) return text + part
    return `${text} ${part}`
  }, '')
}

async function askGemini(env, prompt) {
  const model = env.geminiModel.replace(/^models\//, '')
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // The key travels in a header, not the query string, so it never appears
      // in a URL that could end up in a log.
      'x-goog-api-key': env.geminiKey,
    },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new ProviderHttpError(response.status)
  const data = await response.json()
  const parts = data?.candidates?.[0]?.content?.parts
  const text = Array.isArray(parts)
    ? joinTextParts(
        parts
          .filter((part) => part && typeof part.text === 'string' && part.thought !== true)
          .map((part) => part.text),
      )
    : ''
  if (!text.trim()) {
    const reason = data?.promptFeedback?.blockReason
    throw new InvalidOutputError(reason ? `no text returned (blocked: ${reason})` : 'no text returned')
  }
  return text
}

async function askOpenRouter(env, prompt) {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.openRouterKey}`,
    },
    body: JSON.stringify({
      model: env.openRouterModel,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new ProviderHttpError(response.status)
  const data = await response.json()
  const content = data?.choices?.[0]?.message?.content
  const text = Array.isArray(content)
    ? joinTextParts(content.map((part) => part?.text ?? ''))
    : String(content ?? '')
  if (!text.trim()) throw new InvalidOutputError('no text returned')
  return text
}

/**
 * blog_posts.slug is UNIQUE in supabase/schema.sql. If the generated slug is
 * taken, append a short suffix. Only --save ever needs this check.
 */
async function uniqueSlug(env, slug) {
  if (!(await slugExists(env, slug))) return slug
  return `${slug}-${Math.random().toString(36).slice(2, 6)}`
}

async function slugExists(env, slug) {
  const url = `${env.supabaseUrl}/rest/v1/blog_posts?select=slug&slug=eq.${encodeURIComponent(slug)}`
  const response = await fetch(url, {
    headers: supabaseHeaders(env),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) fail(`Could not check the slug against Supabase (HTTP ${response.status}).`)
  const rows = await response.json()
  return Array.isArray(rows) && rows.length > 0
}

/**
 * Insert an unpublished draft. published=false and published_at=null are
 * hard-coded on purpose - this generator must never publish.
 */
async function insertDraft(env, draft, slug) {
  const response = await fetch(`${env.supabaseUrl}/rest/v1/blog_posts`, {
    method: 'POST',
    headers: {
      ...supabaseHeaders(env),
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({
      title: draft.title,
      slug,
      category: draft.category,
      excerpt: draft.excerpt,
      content: draft.content,
      published: false,
      published_at: null,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) fail(`Supabase insert failed (HTTP ${response.status}).`)
}

/**
 * Safety net for the fabrication rule in the prompt: if the model slipped a
 * personal story past it anyway, say so loudly. Nothing is blocked and nothing
 * is rewritten - the draft is only reported, and a human reads it either way.
 */
const FABRICATION_PATTERNS = [
  'my client',
  'our client',
  'a client of mine',
  'last year i',
  'years ago i',
  'i once ',
  'when we did this',
  'i worked with',
]

function warnOnFabrication(draft) {
  const haystack = String(draft?.content ?? '').toLowerCase()
  const hits = FABRICATION_PATTERNS.filter((pattern) => haystack.includes(pattern))
  if (hits.length === 0) return
  console.log('')
  console.log(`WARNING: possible fabricated personal story in the draft (matched: ${hits.join(', ')}).`)
  console.log('The draft is NOT blocked - but these phrases must not be published under a real name. Rewrite or delete them first.')
}

function printDraft(draft) {
  console.log('')
  console.log('--- Draft -------------------------------------------------------')
  console.log(`Title:    ${draft.title}`)
  console.log(`Slug:     ${draft.slug}`)
  console.log(`Category: ${draft.category}`)
  console.log(`Excerpt:  ${draft.excerpt}`)
  console.log('')
  console.log(draft.content)
  console.log('-----------------------------------------------------------------')
  console.log('')
}

async function main() {
  const env = readEnv()

  const rows = await fetchPosts(env)
  const topics = buildTopicLists(rows)
  console.log(
    `Loaded ${rows.length} existing post(s); ${topics.recent.length} from the last ${RECENT_WINDOW_DAYS} days are strictly forbidden.`,
  )

  const prompt = buildPrompt(topics)

  let draft
  let provider
  try {
    draft = await generateDraftRequest('Gemini', () => askGemini(env, prompt))
    provider = 'Gemini'
  } catch (geminiError) {
    console.log(`Gemini failed (${describeFailure(geminiError)}). Falling back to OpenRouter.`)
    try {
      draft = await generateDraftRequest('OpenRouter', () => askOpenRouter(env, prompt))
      provider = 'OpenRouter'
    } catch (openRouterError) {
      fail(`OpenRouter failed (${describeFailure(openRouterError)}). No draft was generated.`)
    }
  }

  console.log(`Provider used: ${provider}`)
  warnOnFabrication(draft)
  printDraft(draft)

  if (!SAVE) {
    console.log('DRY RUN - nothing was written to Supabase.')
    console.log('Re-run with --save to insert this as an unpublished draft.')
    return
  }

  const finalSlug = await uniqueSlug(env, draft.slug)
  if (finalSlug !== draft.slug) {
    console.log(`Slug "${draft.slug}" already exists - saving as "${finalSlug}".`)
  }
  await insertDraft(env, draft, finalSlug)
  console.log(`Saved as an unpublished draft: slug "${finalSlug}" (published=false, published_at=null).`)
  console.log('The rebuild/deploy hook was deliberately not called - publish from /admin when ready.')
}

main().catch((error) => {
  fail(`Fatal: ${describeFailure(error)}`)
})
