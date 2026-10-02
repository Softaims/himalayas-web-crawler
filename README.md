# How the Himalayas Script Works

A plain-English explanation. No coding knowledge needed.

---

## Part 1: What the script does

### In one sentence
You tell it **what jobs** to look for and **where**, and it gives you a file listing the **companies hiring**, with their **website, LinkedIn and CEO**.

### How to start it
```bash
npm run himalayas
```

### The questions it asks you
1. **What to search for**, e.g. "mobile engineer"
2. **Which countries:** US, Canada, Europe (or pick countries one by one)
3. **Include "work from anywhere" jobs?** Usually No
4. **What info you want:** LinkedIn, CEO, salary, etc. (company name and website are always included)
5. **How many jobs at most**, e.g. 100

### What happens after you answer

```
 Step 1               Step 2                    Step 3
 Find jobs     →      Look up each company  →   Save to a file
```

**Step 1: Find jobs**
- The script asks Himalayas: *"Show me mobile engineer jobs in the US."*
- Then the same for Canada, then Germany, then France... one country at a time.
  (Himalayas can't search "Europe" all at once, so the script asks country by country.)
- Every country gets a **fair share**, so the US doesn't take all the spots.
- If the **same job** shows up in two countries, it's kept **once**.

**Step 2: Look up each company**
- The job list only has the company **name**.
- So for each company, the script asks Himalayas a second question:
  *"Tell me about this company."* → website, LinkedIn, CEO, size, and so on.
- It **remembers** answers for 7 days, so next time it doesn't ask again about the same company. (This memory is saved in the `.cache` folder.)

**Step 3: Save to a file**
- Everything goes into one file inside the **`output`** folder.
- The file lists **each company once**, with its jobs listed underneath.

### Example of the result
```
Company:   Bjak
Website:   bjak.my
LinkedIn:  linkedin.com/company/bjak
Jobs:      5 (Mobile Engineer – Germany, Mobile Engineer – Spain, ...)
```

### Stopping early
- Press **Ctrl+C once** → it stops and **saves what it has so far**.
- Press **Ctrl+C twice** → it quits right away without saving.

### What it can't get
Himalayas does **not** share:
- HR managers
- Executives other than the CEO
- Email addresses

---

## Part 2: How rate limiting works

### What is a "rate limit"?
Himalayas only lets you ask **a certain number of questions per minute**.
If you ask too fast, it replies **"429: Too many requests, wait a minute."**

Think of it like a shop counter: if you keep shouting orders, the cashier says *"Slow down, wait a minute."*

### What the limit is
Himalayas doesn't publish the number. Their documentation only says:
> "If you get a 429, wait 60 seconds."

So we tested it (2 Oct 2026, job search only):

| Speed | Result |
|---|---|
| 60 per minute | ✅ Fine |
| 120 per minute | ✅ Fine |
| 180 per minute | ✅ Fine |
| ~190 per minute | ❌ "429: slow down" |

- **The limit is about 190 requests per minute** from one internet connection.
- The "slow down" came from **Cloudflare** (Himalayas' security guard), not from Himalayas itself. It showed its "Just a moment..." robot-check page.
- The block was short: a few minutes later, requests worked again.
- Our script uses about **65 per minute**, roughly a third of the limit, so it's safe.
- The company-details service hasn't been tested yet and may have its own limit.

### How the script stays polite
- It **pauses briefly** between every question.
- It asks about **at most 3 companies at the same time**.

### What happens if Himalayas says "slow down" (429)

```
 Himalayas says "429"
        ↓
 The WHOLE script pauses for 60 seconds
 (not just the part that got the warning)
        ↓
 It tries again
        ↓
 If it still gets "429" after 3 tries → it skips that item and moves on
```

**Why pause everything?** If only one part paused while the others kept asking, Himalayas would get even more annoyed. Pausing everything is the polite way.

### It keeps notes every time this happens
Each time a 429 happens, the script writes down:
- **When** it happened
- **How many questions** it had asked in the last minute

These notes go into **`logs/rate-limit.ndjson`**.
Over time, the notes show roughly where Himalayas' limit is.

You'll also see a line like this on screen:
```
⏸ 429 from search API after 87 requests in the last 60s — pausing all search requests 60s
```

---

## Part 3: Finding the limit yourself (test tool)

There's a separate tool that **slowly speeds up** until Himalayas says "slow down", then **stops immediately**.

### How to run it
```bash
npm run ratelimit-test -- --api search
```
(Use `--api mcp` to test the "company details" side instead.)

### What it does

```
 Minute 1:  1 question per second
 Minute 2:  2 questions per second
 Minute 3:  3 questions per second
 ...
 STOPS the moment Himalayas says "429"
```

### How to read the answer
| You see | Meaning |
|---|---|
| **"429 at 3 req/s… 150 requests in the 60s before it"** | The limit is about **150 per minute**. Keep the main script well below that. |
| **"No limit hit"** | The limit is higher than what was tested. You can test higher next time. |
| **"Blocked (HTTP 403)"** | Cloudflare (Himalayas' security guard) is blocking you. **Stop testing for a few hours.** |

### Simple rules for testing
1. **Don't run the main script at the same time.**
2. **Wait at least 2 minutes** between tests.
3. **Don't repeat it many times**, or your internet connection may get blocked.
4. Need a higher limit? Just email Himalayas: **hi@himalayas.app**

---

## Part 4: The Himalayas APIs we use

The script uses **two free, public services** from Himalayas:

| | API 1: Job Search | API 2: Company Details (MCP) |
|---|---|---|
| **What it gives** | List of jobs | Info about one company |
| **Address** | `https://himalayas.app/jobs/api/search` | `https://mcp.himalayas.app/mcp` |
| **Login / API key?** | ❌ Not needed | ❌ Not needed |
| **Answer format** | JSON (neat data) | Text (the script reads it) |
| **Results per request** | 20 jobs | 1 company |
| **Tested limit** | ~190 requests/minute | Not tested yet |
| **Official docs** | [Jobs API docs](https://himalayas.app/docs/remote-jobs-api) | [MCP docs](https://himalayas.app/docs/remote-jobs-mcp) |

---

### API 1: Job Search

**What it does:** You ask for jobs, and it returns up to 20 per request.

**Try it in the terminal:**
```bash
curl 'https://himalayas.app/jobs/api/search?q=mobile%20engineer&country=US'
```

**Options you can add to the address:**

| Option | What it means | Example |
|---|---|---|
| `q` | Search words | `q=mobile%20engineer` (`%20` = space) |
| `country` | One country (code or name) | `country=US`, `country=Germany` |
| `worldwide` | Only "work from anywhere" jobs | `worldwide=true` |
| `exclude_worldwide` | Hide "work from anywhere" jobs | `exclude_worldwide=true` |
| `seniority` | Experience level | `seniority=Senior` or `Entry-level`, `Mid-level`, `Manager`, `Director`, `Executive` |
| `employment_type` | Type of job | `employment_type=Full%20Time` or `Part Time`, `Contractor`, `Intern`… |
| `company` | Only one company's jobs | `company=stripe` |
| `timezone` | Timezone | `timezone=UTC-5` |
| `sort` | Order of results | `relevant` (default), `recent`, `salaryAsc`, `salaryDesc` |
| `page` | Which page (20 jobs each) | `page=2` |

Join options with `&`, e.g. `?q=react&country=CA&sort=recent&page=2`

**What you get back for each job:**

| Field | Meaning |
|---|---|
| `title` | Job title |
| `companyName` / `companySlug` | Company name and its ID on Himalayas (e.g. `stripe`) |
| `minSalary` / `maxSalary` / `currency` | Salary range (often empty) |
| `seniority` / `employmentType` | Level and job type |
| `locationRestrictions` | Countries allowed (empty = anywhere) |
| `timezoneRestrictions` | Allowed timezones |
| `applicationLink` | Link to the job |
| `pubDate` / `expiryDate` | Posted and expiry dates |
| `description` | Full job text |

**Good to know:**
- ⚠️ **Only one country per request.** `country=US,CA` and `country=Europe` don't work. That's why the script asks country by country.
- The top of each answer includes **`totalCount`**, the total number of matching jobs.
- There's also a **"browse everything"** address with no filters: `https://himalayas.app/jobs/api` (about 98,000 jobs, 20 at a time).

---

### API 2: Company Details (MCP server)

**What it does:** You give it a company ID (e.g. `stripe`), and it returns the company's details.

**What "MCP" means:** it's a service built for AI assistants (like Claude or ChatGPT), but any program can use it. You send a small message, and it replies with text.

**Try it in the terminal:**
```bash
curl -s https://mcp.himalayas.app/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"get_company_details","arguments":{"company_slug":"stripe"}}}'
```

**What it replies (simplified):**
```
# Stripe
Size: 1001-5000
Founded: 2009
CEO: Patrick Collison
Markets: Payments, Developer-Tools, ...
Website: https://stripe.com
Social: Twitter: ... • LinkedIn: https://linkedin.com/company/stripe • Facebook: ...
```

**What the script picks out of it:** domain, website, LinkedIn, other socials, CEO, size, founded year, hiring countries, markets, tech stack and the "about" text.

**Good to know:**
- ⚠️ The reply is **text written for an AI to read, not neat data**. The script has to read it line by line. If Himalayas changes the wording, that part of the script may need fixing.
- If a company has no profile, it replies: *"Company '…' not found."*
- The MCP server has **41 tools** in total. Other useful free ones:
  - `search_companies`: find companies by keyword, country or tech stack
  - `get_salary_data`: average salary for a job title
  - `search_jobs`: like API 1, with extra filters (minimum salary, benefits)

---

### Things that apply to both APIs

| Topic | What to know |
|---|---|
| **Login** | None needed. Both are free and public. |
| **Data freshness** | Himalayas updates its data **once every 24 hours**, so running more than once a day gives nothing new. |
| **Caching** | Himalayas remembers identical searches for up to 1 hour (via Cloudflare). The company service doesn't cache. |
| **Too many requests** | You get **429**, and should wait 60 seconds (see Part 2). |
| **Credit** | If you show this data publicly, you must **link back to himalayas.app**. |
| **Not available** | HR contacts, executives other than the CEO, and emails. |
| **Need more?** | Email **hi@himalayas.app** for a higher limit. |

---

## Where things are saved

| Folder | What's inside |
|---|---|
| `output/` | Your results (one file per run) |
| `.cache/` | Remembered company details (saves time on the next run) |
| `logs/` | Rate-limit notes and test reports |

---

## Which file does what (if you're curious)

All code is in the `himalayas/` folder.

| File | Job |
|---|---|
| `himalayas/index.js` | Asks you the questions, runs everything, saves the file |
| `himalayas/crawler.js` | Goes country by country to find jobs, then looks up companies |
| `himalayas/jobsApi.js` | Talks to the Himalayas job search |
| `himalayas/mcp.js` | Talks to Himalayas' company-details service and reads its answers |
| `himalayas/http.js` | Handles waiting, retrying and the 60-second pause |
| `himalayas/fields.js` | The list of info you can choose (LinkedIn, CEO, salary, etc.) |
| `himalayas/regions.js` | The list of countries |
| `himalayas/cache.js` | Remembers company details for 7 days |
| `himalayas/ratelimit-test.js` | The test tool from Part 3 |
