/**
 * blog-agent/publish-draft.mjs
 *
 * The publish half of the review window: read ONE draft row out of Supabase,
 * run the safety checks on it, and - only when run with --apply - flip it from
 * published=false to published=true.
 *
 * Deliberate constraints:
 *   - No dependencies: plain Node `fetch` talks to Supabase PostgREST, and
 *     node:fs appends to GITHUB_OUTPUT when a workflow provides one.
 *   - Default mode is a DRY RUN: the row is read and reported, nothing is
 *     ever written. --apply is the only way this script writes to Supabase.
 *   - --apply guards the UPDATE with published=eq.false and expects exactly
 *     one row back, so a row that is already published is never touched.
 *   - Nothing is ever inserted or deleted, and no other file is written.
 *   - This script never calls the rebuild/deploy hook.
 *   - Keys and header values are never printed. An HTTP failure prints the
 *     status code and the response text only, then exits non-zero.
 *
 * Usage:
 *   node publish-draft.mjs --slug my-post-slug          # dry run, report only
 *   node publish-draft.mjs --slug my-post-slug --apply  # publish after checks
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. A missing variable is
 * reported by name only; secret values are never printed anywhere.
 */

import { appendFileSync } from 'node:fs'

const REQUEST_TIMEOUT_MS = 60_000

const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']

const MIN_WORDS = 400
const MAX_WORDS = 1000
const MIN_HEADINGS = 2

/**
 * Personal-experience claims. These posts go out under a real name, so any of
 * these blocks the publish - the same list generate-draft.mjs warns about.
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

/** Leftover placeholders and machine tells - never for a published post. */
const PLACEHOLDER_PATTERNS = ['as an ai', 'lorem ipsum', '[insert', 'todo', '{{']

class HttpError extends Error {
  constructor(status, bodyText) {
    super(`HTTP ${status}`)
    this.status = status
    this.bodyText = bodyText
  }
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

function describeFailure(error) {
  // HTTP failures print only the status code and the response text - never a
  // header, a key or any other part of the request.
  if (error instanceof HttpError) return `HTTP ${error.status}: ${error.bodyText}`
  if (error?.name === 'TimeoutError') return 'request timed out'
  if (error instanceof TypeError) return 'network error'
  return error?.message || 'unknown error'
}

/**
 * The environment. The values are only ever sent to Supabase as headers -
 * they are never logged, never echoed into errors, never written out.
 */
function readEnv() {
  const missing = REQUIRED_ENV.filter((name) => !String(process.env[name] ?? '').trim())
  if (missing.length > 0) {
    fail(`Missing required environment variable(s): ${missing.join(', ')}`)
  }
  return {
    supabaseUrl: String(process.env.SUPABASE_URL).trim().replace(/\/+$/, ''),
    supabaseServiceKey: String(process.env.SUPABASE_SERVICE_ROLE_KEY).trim(),
  }
}

function supabaseHeaders(env) {
  return {
    apikey: env.supabaseServiceKey,
    Authorization: `Bearer ${env.supabaseServiceKey}`,
    Accept: 'application/json',
  }
}

/** --slug <slug> (required) and optional --apply. */
function parseArgs(argv) {
  const args = { slug: '', apply: false }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--slug') {
      const value = String(argv[index + 1] ?? '').trim()
      if (!value || value.startsWith('--')) fail('--slug needs a value, like: --slug why-ad-copy-stops-working')
      args.slug = value.toLowerCase()
      index += 1
      continue
    }
    if (arg === '--apply') {
      args.apply = true
      continue
    }
    fail(`Unknown argument: ${arg}`)
  }

  if (!args.slug) fail('Usage: node publish-draft.mjs --slug <slug> [--apply]')
  return args
}

function countWords(content) {
  return content.split(/\s+/).filter(Boolean).length
}

function countHeadings(content) {
  return content.split(/\r?\n/).filter((line) => line.startsWith('## ')).length
}

/**
 * All four checks a draft must pass before it may be published:
 *   (a) no personal-story claim anywhere in the content,
 *   (b) the content is between 400 and 1000 words (inclusive),
 *   (c) at least MIN_HEADINGS lines start with "## ",
 *   (d) title, excerpt, category and content are all non-empty, and the
 *       content contains no placeholder text.
 * Returns { failures, words, headings }; an empty failures list means pass.
 */
function runSafetyChecks(row) {
  const title = String(row?.title ?? '').trim()
  const excerpt = String(row?.excerpt ?? '').trim()
  const category = String(row?.category ?? '').trim()
  const content = String(row?.content ?? '')
  const haystack = content.toLowerCase()
  const failures = []

  const claims = FABRICATION_PATTERNS.filter((pattern) => haystack.includes(pattern))
  if (claims.length > 0) failures.push(`(a) personal-story phrase(s) in content: ${claims.join(', ')}`)

  const words = countWords(content)
  if (words < MIN_WORDS || words > MAX_WORDS) {
    failures.push(`(b) word count ${words} is outside ${MIN_WORDS}-${MAX_WORDS}`)
  }

  const headings = countHeadings(content)
  if (headings < MIN_HEADINGS) {
    failures.push(`(c) only ${headings} line(s) start with "## " (need at least ${MIN_HEADINGS})`)
  }

  const problems = []
  if (!title) problems.push('title is empty')
  if (!excerpt) problems.push('excerpt is empty')
  if (!category) problems.push('category is empty')
  if (!content.trim()) problems.push('content is empty')
  const placeholders = PLACEHOLDER_PATTERNS.filter((pattern) => haystack.includes(pattern))
  if (placeholders.length > 0) problems.push(`placeholder text in content: ${placeholders.join(', ')}`)
  if (problems.length > 0) failures.push(`(d) ${problems.join('; ')}`)

  return { failures, words, headings }
}

/**
 * Read the one row for this slug. PostgREST answers with [] when there is no
 * such slug. An HTTP failure throws with the status and the response text.
 */
async function fetchRow(env, slug) {
  const url = `${env.supabaseUrl}/rest/v1/blog_posts?slug=eq.${encodeURIComponent(slug)}&select=slug,title,excerpt,content,category,published,published_at`
  const response = await fetch(url, {
    headers: supabaseHeaders(env),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await response.text()
  if (!response.ok) throw new HttpError(response.status, text)
  let rows
  try {
    rows = JSON.parse(text)
  } catch {
    fail('Supabase returned a response that was not JSON.')
  }
  if (!Array.isArray(rows)) fail('Supabase returned an unexpected payload for blog_posts.')
  return rows
}

/**
 * --apply only: set published=true and published_at to now, guarded by
 * published=eq.false so an already-published row cannot match. Returns the
 * number of rows Supabase confirmed back.
 */
async function publishRow(env, slug) {
  const url = `${env.supabaseUrl}/rest/v1/blog_posts?slug=eq.${encodeURIComponent(slug)}&published=eq.false`
  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      ...supabaseHeaders(env),
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({ published: true, published_at: new Date().toISOString() }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await response.text()
  if (!response.ok) throw new HttpError(response.status, text)
  let rows
  try {
    rows = JSON.parse(text)
  } catch {
    fail('Supabase returned a response that was not JSON.')
  }
  if (!Array.isArray(rows)) fail('Supabase returned an unexpected payload for blog_posts.')
  return rows.length
}

/**
 * The two workflow outputs, appended with node:fs - and nothing else. When
 * GITHUB_OUTPUT is unset no file is touched at all.
 */
function writeGithubOutput(status, slug) {
  const file = String(process.env.GITHUB_OUTPUT ?? '').trim()
  if (!file) return
  appendFileSync(file, `status=${status}\nslug=${slug}\n`)
}

async function main() {
  const env = readEnv()
  const args = parseArgs(process.argv.slice(2))

  const rows = await fetchRow(env, args.slug)
  let status

  if (rows.length === 0) {
    status = 'missing'
    console.log(`No row in blog_posts has the slug "${args.slug}".`)
  } else if (rows[0].published === true) {
    status = 'already-published'
    console.log('The row is already published - nothing to do.')
  } else {
    const { failures, words, headings } = runSafetyChecks(rows[0])
    console.log(`Row: "${String(rows[0].title ?? '').trim()}" (${words} words, ${headings} "## " heading(s)).`)
    if (failures.length > 0) {
      status = 'blocked'
      console.log('Safety checks FAILED:')
      for (const failure of failures) console.log(`  - ${failure}`)
      console.log('Nothing was written.')
    } else if (!args.apply) {
      status = 'dry-run-ok'
      console.log('Safety checks passed. DRY RUN - nothing was written.')
      console.log('Re-run with --apply to publish this row.')
    } else {
      const updated = await publishRow(env, args.slug)
      if (updated > 1) fail(`Supabase confirmed ${updated} updated rows, expected exactly 1.`)
      if (updated === 1) {
        status = 'published'
        console.log('Published: 1 row updated (published=true, published_at set).')
      } else {
        status = 'missing'
        console.log('The update matched no row - nothing was changed.')
      }
    }
  }

  writeGithubOutput(status, args.slug)
  console.log(`STATUS: ${status} ${args.slug}`)
}

main().catch((error) => {
  fail(`Fatal: ${describeFailure(error)}`)
})
