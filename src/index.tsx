import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'

type Bindings = { DB: D1Database, USER1?: string, USER2?: string }
type Status = 'workout' | 'skip'

const app = new Hono<{ Bindings: Bindings }>()

function baseNames(env: Bindings) {
  const u1 = (env.USER1 ?? '').trim()
  const u2 = (env.USER2 ?? '').trim()
  return { user1: u1 || 'User1', user2: u2 || 'User2' }
}

/** ===== Time (JST) ===== */
function jstYmd(d = new Date()): string {
  const s = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
  const [y, m, day] = s.split('/')
  return `${y}-${m}-${day}`
}
function addDays(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0))
  dt.setUTCDate(dt.getUTCDate() + delta)
  const yy = dt.getUTCFullYear()
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(dt.getUTCDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

/** ===== DB helpers ===== */
async function ensureBaseUsers(db: D1Database, names: { user1: string, user2: string }) {
  // 2枠固定（user1/user2）
  const now = Date.now()
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO users (id, display_name) VALUES ('user1', ?)`).bind(names.user1),
    db.prepare(`INSERT OR IGNORE INTO users (id, display_name) VALUES ('user2', ?)`).bind(names.user2),
    db.prepare(`INSERT OR IGNORE INTO user_state (user_id, skip_points, consec_workout, updated_at)
                VALUES ('user1', 2, 0, ?)`).bind(now),
    db.prepare(`INSERT OR IGNORE INTO user_state (user_id, skip_points, consec_workout, updated_at)
                VALUES ('user2', 2, 0, ?)`).bind(now),
  ])
}

function currentUserId(c: any): 'user1' | 'user2' | null {
  const uid = getCookie(c, 'uid')
  return uid === 'user1' || uid === 'user2' ? uid : null
}

/** ===== Logic ===== */
async function upsertWorkout(db: D1Database, userId: string, date: string) {
  // already exists?
  const ex = await db.prepare(`SELECT status FROM days WHERE user_id=? AND date=?`)
    .bind(userId, date).first<{ status: Status }>()
  if (ex) return

  await db.prepare(`INSERT INTO days (user_id, date, status, created_at) VALUES (?,?, 'workout', ?)`)
    .bind(userId, date, Date.now()).run()

  const st = await db.prepare(`SELECT skip_points, consec_workout FROM user_state WHERE user_id=?`)
    .bind(userId).first<{ skip_points: number, consec_workout: number }>()
  if (!st) return

  const y = addDays(date, -1)
  const ys = await db.prepare(`SELECT status FROM days WHERE user_id=? AND date=?`)
    .bind(userId, y).first<{ status: Status }>()

  let consec = 1
  if (ys?.status === 'workout') consec = st.consec_workout + 1
  else consec = 1

  let skip = st.skip_points
  if (consec % 2 === 0 && skip < 2) skip += 1

  await db.prepare(`UPDATE user_state SET skip_points=?, consec_workout=?, updated_at=? WHERE user_id=?`)
    .bind(skip, consec, Date.now(), userId).run()
}

async function useSkip(db: D1Database, userId: string, date: string) {
  const st = await db.prepare(`SELECT skip_points FROM user_state WHERE user_id=?`)
    .bind(userId).first<{ skip_points: number }>()
  if (!st || st.skip_points <= 0) return

  const ex = await db.prepare(`SELECT status FROM days WHERE user_id=? AND date=?`)
    .bind(userId, date).first<{ status: Status }>()
  if (ex) return

  await db.prepare(`INSERT INTO days (user_id, date, status, created_at) VALUES (?,?, 'skip', ?)`)
    .bind(userId, date, Date.now()).run()

  // skip使用で連続は切る
  await db.prepare(`UPDATE user_state SET skip_points=?, consec_workout=0, updated_at=? WHERE user_id=?`)
    .bind(st.skip_points - 1, Date.now(), userId).run()
}

/** ===== UI ===== */
function computeDays(weeks = 24) {
  const totalDays = weeks * 7
  const today = jstYmd()
  const start = addDays(today, -(totalDays - 1))
  const days: string[] = []
  for (let d = start; d <= today; d = addDays(d, 1)) days.push(d)
  return { start, today, days }
}

async function getUserCard(db: D1Database, userId: 'user1' | 'user2') {
  const user = await db.prepare(`SELECT id, display_name FROM users WHERE id=?`)
    .bind(userId).first<{ id: string, display_name: string }>()
  const st = await db.prepare(`SELECT skip_points, consec_workout FROM user_state WHERE user_id=?`)
    .bind(userId).first<{ skip_points: number, consec_workout: number }>()
  const rows = await db.prepare(`SELECT date, status FROM days WHERE user_id=?`).bind(userId).all<{ results: { date: string, status: Status }[] }>()
  const map = new Map<string, Status>()
  for (const r of rows.results ?? []) map.set(r.date, r.status)
  return { user, st, map }
}

function Layout(props: { children: any }) {
  return (
    <html>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>筋トレ草カード</title>
        <style>{`
          body{font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 18px; }
          button,input{font: inherit;}
          .top{display:flex; gap:12px; flex-wrap:wrap; align-items:center; justify-content:center;}
          .card{border:1px solid #ddd; border-radius:14px; padding:12px 14px; width: fit-content;}
          .row{display:flex; gap:10px; flex-wrap:wrap;}
          .btn{border:1px solid #ccc; background:#fff; padding:10px 12px; border-radius:12px; cursor:pointer; font-size:14px;}
          .btn-subtle{border:1px dashed #ddd; color:#666; background:#fafafa; font-size:14px;}
          .icon-btn{border:1px solid #e0e0e0; background:#fff; width:36px; height:36px; border-radius:10px; display:inline-flex; justify-content:center; cursor:pointer; align-items:center; text-decoration:none;}
          .icon-btn svg{width:18px; height:18px; stroke:#666;}
          .btn:active{transform: translateY(1px);}
          .muted{color:#666; font-size: 12px;}
          .pill{display:inline-block; padding:2px 8px; border-radius:999px; border:1px solid #ddd; font-size: 12px;}
          .two{display:grid; grid-template-columns: max-content; gap: 12px; justify-items:center; justify-content:center;}
          .grid{display:grid; grid-auto-flow:column; grid-auto-columns:12px; grid-template-rows: repeat(7, 12px); row-gap:3px; column-gap:3px; padding: 8px; overflow-x:auto;}
          .cell{width:12px; height:12px; border-radius: 3px; background:#ebedf0;}
          .w{background:#40c463;}
          .s{background:#9be9a8;}
        `}</style>
      </head>
      <body>{props.children}</body>
    </html>
  )
}

app.get('/setup', async (c) => {
  const names = baseNames(c.env)
  await ensureBaseUsers(c.env.DB, names)

  return c.html(
    <Layout>
      <div class="card">
        <div class="row" style="justify-content:space-between;">
          <div>
            <b>設定</b>
            <div class="muted">この端末のユーザー設定</div>
          </div>
        </div>

        <div style="height:10px"></div>

        <form method="post" action="/setup">
          <div class="row">
            <div class="pill">この端末のユーザー</div>
            <label class="row">
              <input type="radio" name="uid" value="user1" checked />
              <span class="pill">{names.user1}</span>
            </label>
            <label class="row">
              <input type="radio" name="uid" value="user2" />
              <span class="pill">{names.user2}</span>
            </label>
          </div>

          <div style="height:10px"></div>

          <div class="row">
            <div style="min-width:220px;">
              <div class="muted">表示名（草カードに出る名前）</div>
              <input name="display_name" placeholder="例: Aさん / Bさん" style="width:100%; padding:10px; border-radius:12px; border:1px solid #ccc;" />
            </div>
            <button class="btn" type="submit">この端末で使う</button>
          </div>

          <div style="height:10px"></div>
          <div class="muted">※ もう片方のスマホでも同じURLにアクセスして、もう一人分を選べばOK</div>
        </form>
      </div>
    </Layout>
  )
})

app.post('/setup', async (c) => {
  const names = baseNames(c.env)
  await ensureBaseUsers(c.env.DB, names)
  const body = await c.req.parseBody()
  const uid = body['uid']
  const display = (body['display_name'] ?? '').toString().trim()

  const userId = uid === 'user2' ? 'user2' : 'user1'
  if (display.length > 0) {
    await c.env.DB.prepare(`UPDATE users SET display_name=? WHERE id=?`).bind(display, userId).run()
  }

  setCookie(c, 'uid', userId, { path: '/', httpOnly: true, sameSite: 'Lax' })
  return c.redirect('/')
})

app.post('/logout', async (c) => {
  deleteCookie(c, 'uid', { path: '/' })
  return c.redirect('/setup')
})

app.get('/', async (c) => {
  const names = baseNames(c.env)
  await ensureBaseUsers(c.env.DB, names)
  const uid = currentUserId(c)
  if (!uid) return c.redirect('/setup')

  const { days } = computeDays(24)

  const u1 = await getUserCard(c.env.DB, 'user1')
  const u2 = await getUserCard(c.env.DB, 'user2')

  const me = uid === 'user1' ? u1 : u2

  const renderGrid = (m: Map<string, Status>) => (
    <div class="grid">
      {days.map((d) => {
        const st = m.get(d)
        const cls = st === 'workout' ? 'cell w' : st === 'skip' ? 'cell s' : 'cell'
        return <div class={cls} title={`${d} : ${st ?? 'none'}`}></div>
      })}
    </div>
  )

  const Card = (x: any) => (
    <div class="card">
      <div class="row" style="justify-content:space-between;">
        <div>
          <b>{x.user?.display_name ?? x.user?.id}</b> <span class="pill">{x.user?.id}</span>
          <div class="muted">skip: <b>{x.st?.skip_points ?? 0}</b>/2 ・ 連続: <b>{x.st?.consec_workout ?? 0}</b> 日</div>
        </div>
      </div>
      <div style="height:8px"></div>
      {renderGrid(x.map)}
      <div class="muted">緑=筋トレ / 薄緑=skip使用 / 灰=未記録</div>
    </div>
  )

  return c.html(
    <Layout>
      <div class="top">
        <div class="card">
          <b>筋トレ草カード</b>
          <div class="muted">今日（JST）: {jstYmd()} ・ この端末の操作ユーザー: <span class="pill">{me.user?.display_name ?? uid}</span></div>
          <div style="height:10px"></div>
          <div class="row">
            <form method="post" action="/workout"><button class="btn" type="submit">今日やった！</button></form>
            <form method="post" action="/skip"><button class="btn" type="submit">今日サボり（skip消費）</button></form>
            <a class="icon-btn" href="/setup" aria-label="設定">
              <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3"></circle>
                <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h.1a1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"></path>
              </svg>
            </a>
          </div>
          <div class="muted" style="margin-top:8px;">連続2日筋トレで skip が1回復（最大2）</div>
        </div>
      </div>

      <div style="height:12px"></div>

      <div class="two">
        {Card(u1)}
        {Card(u2)}
      </div>
    </Layout>
  )
})

app.post('/workout', async (c) => {
  const names = baseNames(c.env)
  await ensureBaseUsers(c.env.DB, names)
  const uid = currentUserId(c)
  if (!uid) return c.redirect('/setup')
  await upsertWorkout(c.env.DB, uid, jstYmd())
  return c.redirect('/')
})

app.post('/skip', async (c) => {
  const names = baseNames(c.env)
  await ensureBaseUsers(c.env.DB, names)
  const uid = currentUserId(c)
  if (!uid) return c.redirect('/setup')
  await useSkip(c.env.DB, uid, jstYmd())
  return c.redirect('/')
})

export default app
