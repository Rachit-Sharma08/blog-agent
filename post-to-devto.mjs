/**
 * blog-agent/post-to-devto.mjs
 *
 * Cross-posts ONE already-published blog post from Supabase to dev.to, so the
 * dev.to copy points back to the original through canonical_url.
 *
 * Deliberate constraints:
 *   - No dependencies: plain Node `fetch` talks to Supabase and dev.to.
 *   - Supabase is READ ONLY here. This script never inserts, updates or
 *     deletes anything, and it never calls the rebuild/deploy hook.
 *   - Default mode is a DRY RUN: the post that would go out and the exact JSON
 *     body are printed, nothing is sent.
 *   - At most one post per run (the oldest eligible one), unless --slug asks
 *     for one specific post.
 *   - --wait-live can hold a run open for up to 20 minutes while it re-checks
 *     the sitemap every 30 seconds. It still posts at most one post, and when
 *     the time runs out it exits 0 without posting.
 *
 * Usage:
 *   node post-to-devto.mjs                       # dry run, oldest recent post
 *   node post-to-devto.mjs --slug my-post-slug   # dry run, one specific post
 *   node post-to-devto.mjs --wait-live 10        # wait up to 10 min for the sitemap
 *   node post-to-devto.mjs --post-draft          # real request, published: false
 *   node post-to-devto.mjs --post                # real request, published: true
 *
 * Env (see blog-agent/.env.example): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * DEVTO_API_KEY, SITE_URL. A missing variable is reported by name only; keys
 * and header values are never printed anywhere.
 */

const DAY_MS = 24 * 60 * 60 * 1000
const RECENT_DAYS = 14
const REQUEST_TIMEOUT_MS = 60_000
const WAIT_LIVE_POLL_MS = 30_000
const WAIT_LIVE_MAX_MINUTES = 20

const DEVTO_API = 'https://dev.to/api'
const DEVTO_USER_AGENT = 'blog-agent'

const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'DEVTO_API_KEY', 'SITE_URL']

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
  if (error instanceof HttpError) return `HTTP ${error.status}`
  if (error?.name === 'TimeoutError') return 'request timed out'
  if (error instanceof TypeError) return 'network error'
  return error?.message || 'unknown error'
}

/**
 * Read the environment. The values are only ever sent to the two APIs - they
 * are never logged, never echoed into errors, never written out.
 */
function readEnv() {
  const missing = REQUIRED_ENV.filter((name) => !String(process.env[name] ?? '').trim())
  if (missing.length > 0) {
    fail(`Missing required environment variable(s): ${missing.join(', ')}`)
  }
  return {
    supabaseUrl: String(process.env.SUPABASE_URL).trim().replace(/\/+$/, ''),
    supabaseServiceKey: String(process.env.SUPABASE_SERVICE_ROLE_KEY).trim(),
    devtoKey: String(process.env.DEVTO_API_KEY).trim(),
    // SITE_URL is public, not a secret - it is only the canonical link target.
    siteUrl: String(process.env.SITE_URL).trim().replace(/\/+$/, ''),
  }
}

/**
 * --slug <slug>, --wait-live <minutes>, --post-draft or --post. Both posting
 * flags at once is an error. --wait-live takes whole minutes, 1 to 20.
 */
function parseArgs(argv) {
  const args = { slug: '', mode: 'dry-run', waitLiveMinutes: 0 }
  let wantsPost = false
  let wantsDraft = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--slug') {
      const value = String(argv[index + 1] ?? '').trim()
      if (!value || value.startsWith('--')) fail('--slug needs a value, like: --slug why-ad-copy-stops-working')
      args.slug = value.toLowerCase()
      index += 1
      continue
    }
    if (arg === '--wait-live') {
      const value = String(argv[index + 1] ?? '').trim()
      if (!/^[0-9]+$/.test(value)) fail('--wait-live needs whole minutes, like: --wait-live 10')
      const minutes = Number(value)
      if (minutes < 1 || minutes > WAIT_LIVE_MAX_MINUTES) {
        fail(`--wait-live takes 1 to ${WAIT_LIVE_MAX_MINUTES} minutes.`)
      }
      args.waitLiveMinutes = minutes
      index += 1
      continue
    }
    if (arg === '--post') {
      wantsPost = true
      continue
    }
    if (arg === '--post-draft') {
      wantsDraft = true
      continue
    }
    fail(`Unknown argument: ${arg}`)
  }

  if (wantsPost && wantsDraft) fail('Use either --post or --post-draft, not both.')
  if (wantsPost) args.mode = 'post'
  else if (wantsDraft) args.mode = 'post-draft'
  return args
}

function supabaseHeaders(env) {
  return {
    apikey: env.supabaseServiceKey,
    Authorization: `Bearer ${env.supabaseServiceKey}`,
    Accept: 'application/json',
  }
}

/** Every published post, oldest first. Read only - a plain GET. */
async function fetchPublishedPosts(env) {
  const query = 'select=slug,title,excerpt,content,category,cover_image_url,published_at&published=eq.true&order=published_at.asc'
  const response = await fetch(`${env.supabaseUrl}/rest/v1/blog_posts?${query}`, {
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
 * Candidate posts: published inside the last RECENT_DAYS days, oldest first.
 * With --slug only that one post is considered, however old it is.
 */
function selectCandidates(posts, args) {
  if (args.slug) {
    return posts.filter((post) => String(post?.slug ?? '').trim().toLowerCase() === args.slug)
  }
  const cutoff = Date.now() - RECENT_DAYS * DAY_MS
  return posts.filter((post) => {
    const time = Date.parse(String(post?.published_at ?? ''))
    return Number.isFinite(time) && time >= cutoff
  })
}

async function fetchSitemapText(env) {
  const response = await fetch(`${env.siteUrl}/sitemap.xml`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await response.text()
  if (!response.ok) throw new HttpError(response.status, text)
  return text
}

/**
 * The site is pre-rendered at build time, so a freshly published post is only
 * really live once its URL shows up in sitemap.xml. No rebuild hook is called
 * from here - that stays a human decision.
 */
function isLiveOnSite(sitemapText, slug) {
  return String(sitemapText ?? '').includes(`/blog/${slug}`)
}

/**
 * --wait-live: re-fetch the sitemap every 30 seconds until /blog/<slug> shows
 * up or the minute budget is spent. Read only - a plain GET per poll.
 * Returns true as soon as the post is live, false when the time ran out.
 */
async function waitForSlugLive(env, slug, minutes) {
  const deadline = Date.now() + minutes * 60_000
  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    await new Promise((resolve) => setTimeout(resolve, Math.min(WAIT_LIVE_POLL_MS, remaining)))
    if (isLiveOnSite(await fetchSitemapText(env), slug)) return true
  }
}

/** My dev.to articles, drafts included. */
async function fetchDevtoArticles(env) {
  const response = await fetch(`${DEVTO_API}/articles/me/all?per_page=1000`, {
    headers: {
      'api-key': env.devtoKey,
      Accept: 'application/vnd.forem.api-v1+json',
      'User-Agent': DEVTO_USER_AGENT,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await response.text()
  if (!response.ok) throw new HttpError(response.status, text)
  let articles
  try {
    articles = JSON.parse(text)
  } catch {
    fail('dev.to returned a response that was not JSON.')
  }
  if (!Array.isArray(articles)) fail('dev.to returned an unexpected payload for the article list.')
  return articles
}

/** Lowercase, no query, no hash, no trailing slash - comparable URLs. */
function normalizeUrl(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
}

function canonicalUrlFor(env, slug) {
  return `${env.siteUrl}/blog/${slug}`
}

/**
 * A post is already cross-posted when one of my dev.to articles points at the
 * same canonical URL, or carries the same title (case-insensitive).
 * Returns the list of matches, empty when there is none.
 */
function findDuplicateMatches(articles, canonicalUrl, title) {
  const wantedUrl = normalizeUrl(canonicalUrl)
  const wantedTitle = String(title ?? '').trim().toLowerCase()
  const matches = []

  for (const article of articles) {
    if (normalizeUrl(article?.canonical_url) === wantedUrl) matches.push('canonical_url')
    if (String(article?.title ?? '').trim().toLowerCase() === wantedTitle) matches.push('title')
  }
  return [...new Set(matches)]
}

/**
 * dev.to tags: lowercase letters and numbers only, unique, max 4.
 * The AI-disclosure tag "abotwrotethis" is always present and must never be
 * dropped by the cap - only three values go in, so the cap cannot reach it.
 */
function buildTags(category) {
  const tags = []
  for (const value of [category, 'marketing', 'abotwrotethis']) {
    const tag = String(value ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '')
    if (tag && !tags.includes(tag)) tags.push(tag)
  }
  return tags.slice(0, 4)
}

/** main_image is only sent when cover_image_url is a real absolute https URL. */
function absoluteHttpsUrl(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  try {
    const url = new URL(text)
    return url.protocol === 'https:' ? text : ''
  } catch {
    return ''
  }
}

/** The exact JSON body for POST /api/articles, minus nothing - no key inside. */
function buildArticle(env, post, published) {
  const canonicalUrl = canonicalUrlFor(env, post.slug)
  const bodyMarkdown = `${post.content}\n\n*Originally published at [${canonicalUrl}](${canonicalUrl})*`
  const article = {
    title: post.title,
    body_markdown: bodyMarkdown,
    published,
    description: post.excerpt,
    canonical_url: canonicalUrl,
    tags: buildTags(post.category),
  }
  const mainImage = absoluteHttpsUrl(post.cover_image_url)
  if (mainImage) article.main_image = mainImage
  return article
}

function printDryRun(post, article) {
  console.log('')
  console.log('--- DRY RUN - the post that would be cross-posted ----------------')
  console.log(`Title:       ${post.title}`)
  console.log(`Slug:        ${post.slug}`)
  console.log(`Published:   ${post.published_at}`)
  console.log(`Canonical:   ${article.canonical_url}`)
  console.log('')
  console.log('POST https://dev.to/api/articles would send this body:')
  console.log(JSON.stringify({ article }, null, 2))
  console.log('')
  console.log('DRY RUN - nothing was sent to dev.to.')
  console.log('Re-run with --post-draft (published: false) or --post (published: true).')
}

/** POST the article. Errors print the status and the response body, never headers. */
async function postArticle(env, article) {
  const response = await fetch(`${DEVTO_API}/articles`, {
    method: 'POST',
    headers: {
      'api-key': env.devtoKey,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.forem.api-v1+json',
      'User-Agent': DEVTO_USER_AGENT,
    },
    body: JSON.stringify({ article }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await response.text()
  if (!response.ok) fail(`dev.to rejected the article (HTTP ${response.status}): ${text}`)
  try {
    return JSON.parse(text)
  } catch {
    fail('dev.to returned a response that was not JSON, so the article URL is unknown.')
  }
}

async function main() {
  const env = readEnv()
  const args = parseArgs(process.argv.slice(2))
  const published = args.mode === 'post'

  const posts = await fetchPublishedPosts(env)
  console.log(`Supabase: ${posts.length} published post(s), read only.`)

  const candidates = selectCandidates(posts, args)
  if (candidates.length === 0) {
    if (args.slug) fail(`No published post in Supabase has the slug "${args.slug}".`)
    console.log(`Nothing to do: no post was published in the last ${RECENT_DAYS} days.`)
    return
  }

  const sitemapText = await fetchSitemapText(env)
  const devtoArticles = await fetchDevtoArticles(env)
  console.log(`dev.to: ${devtoArticles.length} article(s) (drafts included) already there.`)

  let chosen = null
  for (const post of candidates) {
    if (!isLiveOnSite(sitemapText, post.slug)) {
      console.log(`Skipping "${post.title}" - /blog/${post.slug} is not in the sitemap yet, the site has not been rebuilt.`)
      continue
    }
    const matches = findDuplicateMatches(devtoArticles, canonicalUrlFor(env, post.slug), post.title)
    if (matches.length > 0) {
      console.log(`Skipping "${post.title}" - already on dev.to (matched: ${matches.join(', ')}).`)
      continue
    }
    chosen = post
    break
  }

  // --wait-live: nothing is postable right now, but a candidate that is only
  // missing from the sitemap may still be on its way. Wait for the oldest one.
  if (!chosen && args.waitLiveMinutes > 0) {
    const pending = candidates.find((post) =>
      !isLiveOnSite(sitemapText, post.slug)
      && findDuplicateMatches(devtoArticles, canonicalUrlFor(env, post.slug), post.title).length === 0)
    if (pending) {
      console.log(`Waiting up to ${args.waitLiveMinutes} minute(s) for /blog/${pending.slug} to appear in sitemap.xml (checking every 30 seconds)...`)
      if (!(await waitForSlugLive(env, pending.slug, args.waitLiveMinutes))) {
        console.log('not live yet, will retry next run')
        return
      }
      // The duplicate check runs again right before posting: the article list
      // above is from the start of the run, and the wait may have taken minutes.
      const freshArticles = await fetchDevtoArticles(env)
      const matches = findDuplicateMatches(freshArticles, canonicalUrlFor(env, pending.slug), pending.title)
      if (matches.length > 0) {
        console.log(`Skipping "${pending.title}" - already on dev.to (matched: ${matches.join(', ')}).`)
        return
      }
      chosen = pending
    }
  }

  if (!chosen) {
    console.log('Nothing to post this run.')
    return
  }

  const article = buildArticle(env, chosen, published)

  if (args.mode === 'dry-run') {
    printDryRun(chosen, article)
    return
  }

  const result = await postArticle(env, article)
  const isDraft = typeof result?.published === 'boolean' ? !result.published : !published
  console.log(`dev.to article id: ${result?.id ?? 'unknown'}`)
  console.log(`URL: ${result?.url || '(no URL returned - a draft has no public URL yet)'}`)
  console.log(isDraft ? 'Posted as a DRAFT (published: false).' : 'Posted as PUBLISHED (published: true).')
}

main().catch((error) => {
  if (error instanceof HttpError) fail(`Fatal: HTTP ${error.status}: ${error.bodyText}`)
  fail(`Fatal: ${describeFailure(error)}`)
})
