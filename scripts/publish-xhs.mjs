// 小红书发布脚本：由 media-desk host 拉起（stdin 不可用，任务从 MEDIA_DESK_PUBLISH_TASK JSON 文件读）。
// 用法：ego-browser nodejs scripts/publish-xhs.mjs（环境变量 MEDIA_DESK_PUBLISH_TASK 指向任务 JSON）
// 任务：{ title, article, images: [绝对路径] }
// 结果：最后一行输出 PUBLISH_RESULT {json}。发布是账号行为：填完直接点发布（按钮点击即授权），失败如实报告不重试。
const fs = await import('node:fs/promises')

const taskPath = process.env.MEDIA_DESK_PUBLISH_TASK
const task = JSON.parse(await fs.readFile(taskPath, 'utf8'))
const summary = { ok: false }

const sleep = ms => new Promise(r => setTimeout(r, ms))

try {
  const taskSpace0 = await taskSpace('media-desk publish')
  const page = await taskSpace0.newPage()
  try {
    await page.goto('https://creator.xiaohongshu.com/publish/publish?source=official', { timeout: 45000 })
    await page.waitForLoadState('load').catch(() => {})
    await sleep(5000)
    const loginWall = await page.evaluate(() => /扫码登录|手机号登录|验证码登录/.test(document.body.innerText.slice(0, 2000)))
    if (loginWall) throw new Error('小红书登录失效，需要在 ego 浏览器里重新登录')

    // 上传图片（必须先传，发布页选「上传图文」后才有标题/正文输入框）
    const input = await page.waitForSelector("input[type='file']", { timeout: 15000 })
    await input.setInputFiles(task.images)
    await sleep(8000)
    // 等待上传完成：至少一张缩略图出现
    await page.waitForFunction(() => document.querySelectorAll('img[src*="sns-img"], img[src*="xhscdn"]').length > 0, { timeout: 120_000 }).catch(() => {})
    await sleep(3000)

    // 标题（限 20 字）与正文（限 1000 字）
    const titleInput = await page.waitForSelector("input[placeholder*='标题'], input[name='title']", { timeout: 20000 })
    await titleInput.fill(task.title.slice(0, 20))
    const editor = await page.waitForSelector(".ql-editor[contenteditable='true'], div[contenteditable='true'][data-placeholder]", { timeout: 15000 })
    await editor.click()
    await page.keyboard.type(task.article.slice(0, 1000), { delay: 5 })
    await sleep(1500)

    // 点发布
    const clicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => /发布/.test((b.textContent || '').trim()) && !/定时|存草稿/.test(b.textContent))
      if (btn) { btn.click(); return btn.textContent.trim() }
      return null
    })
    if (!clicked) throw new Error('没找到发布按钮（页面结构可能变了）')
    await sleep(6000)

    // 发布成功的标志：出现成功提示或跳转离开发布页
    const after = await page.evaluate(() => ({ url: location.href, text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 300) }))
    if (/发布成功|发布已完成/.test(after.text) || !/publish\/publish/.test(after.url)) {
      summary.ok = true
      summary.url = after.url
    } else {
      // 兜底：可能弹出二次弹窗（认发布弹窗确认），找一次「发布」再点
      const again = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(b => /^发布$/.test((b.textContent || '').trim()))
        if (btn) { btn.click(); return true }
        return false
      })
      await sleep(5000)
      const final = await page.evaluate(() => ({ url: location.href, text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 300) }))
      if (again && (/发布成功|发布已完成/.test(final.text) || !/publish\/publish/.test(final.url))) {
        summary.ok = true
        summary.url = final.url
      } else {
        throw new Error('发布后未确认成功：' + final.text.slice(0, 120))
      }
    }
  } finally {
    // 页面留着不关：发布后页面可能还有信息要看；由 host 控制生命周期
    await page.close().catch(() => {})
  }
} catch (err) {
  summary.error = String(err.message || err).slice(0, 300)
}

console.log('PUBLISH_RESULT ' + JSON.stringify(summary))
