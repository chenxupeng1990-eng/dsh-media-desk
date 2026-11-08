// 小红书发布脚本：由 media-desk host 通过 stdin 注入任务后拉起。
// 独立调试也支持 MEDIA_DESK_PUBLISH_TASK 文件路径；ego-browser Node 运行时不依赖 shell 环境变量。
// 任务：{ title, article, images: [绝对路径], dryRun?, screenshotPath? }
// 结果：最后一行输出 PUBLISH_RESULT {json}。发布是账号行为：填完直接点发布（按钮点击即授权），失败如实报告不重试。
const fs = await import('node:fs/promises')

const taskInput = globalThis.__MEDIA_DESK_PUBLISH_TASK ?? process.env.MEDIA_DESK_PUBLISH_TASK
const task = typeof taskInput === 'string' ? JSON.parse(await fs.readFile(taskInput, 'utf8')) : taskInput
if (!task || typeof task !== 'object') throw new Error('发布任务缺失')
const summary = { ok: false }

const sleep = ms => new Promise(r => setTimeout(r, ms))
const egoTask = await taskSpace('media-desk publish')
const page = await egoTask.newPage()

try {
  await page.goto('https://creator.xiaohongshu.com/publish/publish?source=official', { timeout: 45000 })
  await page.waitForLoadState('load').catch(() => {})
  const loginWall = await page.evaluate(() => /扫码登录|手机号登录|验证码登录/.test(document.body.innerText.slice(0, 2000)))
  if (loginWall) throw new Error('小红书登录失效，需要在 ego 浏览器里重新登录')

  // 发布页默认开在「上传视频」；必须先切到「上传图文」，PNG 才能进图片上传框。
  // 页面里有多个隐藏的同名 tab（hover 层），只点视口内可见的那个。
  await page.waitForFunction(() => [...document.querySelectorAll('.creator-tab .title')]
    .some(el => el.textContent.trim() === '上传图文' && !el.closest('[aria-hidden="true"]') && (() => { const r = el.getBoundingClientRect(); return r.x >= 0 && r.y >= 0 && r.x < innerWidth && r.y < innerHeight })()), undefined, { timeout: 20000 })
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('.creator-tab .title')) {
      if (el.textContent.trim() !== '上传图文' || el.closest('[aria-hidden="true"]')) continue
      const r = el.getBoundingClientRect()
      if (r.x >= 0 && r.y >= 0 && r.x < innerWidth && r.y < innerHeight) { el.click(); return }
    }
  })
  // 图文模式的图片上传框（accept 含 png）出现才算切成功；上传框是隐藏元素，用 DOM 轮询而不是可见性等待
  await page.waitForFunction(() => [...document.querySelectorAll('input[type=file]')].some(e => /png/i.test(e.accept)), undefined, { timeout: 20000 })

  await page.setInputFiles("input[type='file'][accept*='png']", task.images)
  // 上传完成：标题输入框出现（图片处理完成后才渲染表单）
  await page.waitForSelector("input[placeholder*='标题']", { timeout: 120_000 })
  await sleep(2000)

  await page.fill("input[placeholder*='标题']", task.title.slice(0, 20))
  await page.click('.tiptap.ProseMirror')
  await page.keyboard.type(task.article.slice(0, 1000), { delay: 5 })
  await page.keyboard.press('Escape')
  await sleep(1500)

  if (task.dryRun) {
    if (task.screenshotPath) await page.screenshot({ path: task.screenshotPath })
    summary.ok = false
    summary.dryRun = true
    summary.stage = 'filled'
  } else {
    const clicked = await page.evaluate(() => {
      const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.x >= 0 && r.y >= 0 && r.x < innerWidth && r.y < innerHeight }
      const btn = [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '发布' && visible(b) && !b.disabled)
      if (btn) { btn.click(); return true }
      return null
    })
    if (!clicked) throw new Error('没找到可用的发布按钮（页面结构可能变了）')
    // 只点一次发布；轮询 20 秒等平台确认。绝不二次点击——重复发布比发布失败严重。
    const deadline = Date.now() + 20_000
    let confirmed = false
    let pageText = ''
    while (Date.now() < deadline) {
      await sleep(2000)
      const after = await page.evaluate(() => ({ url: location.href, text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 400) }))
      pageText = after.text
      if (/发布成功|发布已完成|笔记已发布/.test(after.text) || (!/publish\/publish/.test(after.url) && !/creator\.xiaohongshu\.com\/publish/.test(after.url))) {
        confirmed = true
        summary.url = after.url
        break
      }
      if (/发布失败|内容包含|请修改|审核不通过/.test(after.text)) break
    }
    if (!confirmed) throw new Error('发布已点击但未收到平台确认，请到「笔记管理」核对是否已发出（避免重复，不要直接重发）：' + pageText.slice(0, 150))
  }
} catch (err) {
  summary.error = String(err.message || err).slice(0, 300)
  try { if (task.screenshotPath) await page.screenshot({ path: task.screenshotPath }) } catch { /* 截图失败不影响错误上报 */ }
}

console.log('PUBLISH_RESULT ' + JSON.stringify(summary))
