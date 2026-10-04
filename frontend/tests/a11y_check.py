#!/usr/bin/env python3
"""
axe-core accessibility check for key pages.
Runs as part of the quality-gates CI workflow.
"""
import asyncio
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8123"
PAGES = [
    ("join", f"{BASE}/index.html#/join"),
    ("exam", f"{BASE}/index.html#/exam"),
    ("result", f"{BASE}/index.html#/result"),
    ("dashboard", f"{BASE}/teacher/index.html"),
]

async def check_page(page, name, url):
    await page.goto(url, wait_until="networkidle")
    # Inject axe-core
    await page.add_script_tag(url="https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.8.4/axe.min.js")
    # Run axe
    results = await page.evaluate("""async () => {
        return await axe.run(document, {
            runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] }
        });
    }""")
    violations = results.get("violations", [])
    serious = [v for v in violations if v["impact"] in ("serious", "critical")]
    if serious:
        print(f"\n❌ {name} ({url}): {len(serious)} serious/critical violations")
        for v in serious:
            print(f"  - {v['id']}: {v['description']} (impact: {v['impact']})")
            for node in v["nodes"][:3]:
                print(f"    {node['html'][:120]}...")
            if len(v["nodes"]) > 3:
                print(f"    ... and {len(v['nodes']) - 3} more")
        return False
    else:
        print(f"✅ {name}: no serious/critical violations")
        return True

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page()
        all_ok = True
        for name, url in PAGES:
            ok = await check_page(page, name, url)
            all_ok = all_ok and ok
        await browser.close()
        if not all_ok:
            raise SystemExit("Accessibility violations found")

if __name__ == "__main__":
    asyncio.run(main())