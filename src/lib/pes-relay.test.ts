import http from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createProgram, enablePesRelayForCli } from "../cli.js"
import { LawApiClient } from "./api-client.js"
import { fetchWithRetry } from "./fetch-with-retry.js"
import { getExternalHttpsProxyConfig } from "./external-https-proxy.js"
import { PesRelayError, disablePesRelay, enablePesRelay, pesRelayKey, relayFetch } from "./pes-relay.js"

const NO_KEY = "PES 에 법령 키가 없어요. PES 「조사 도구 · 그림 키」에서 키를 넣으세요."
const XML = `<?xml version="1.0" encoding="UTF-8"?><LawSearch><totalCnt>0</totalCnt></LawSearch>`

interface Seen { method: string; url: string; token?: string; referer?: string; body: string }

/** 중계 흉내: 받은 요청을 적어 두고 `reply` 가 정한 대로 답한다 */
let seen: Seen[] = []
let reply: (req: Seen, res: http.ServerResponse) => void
let relay: http.Server
let relayUrl = ""

beforeAll(async () => {
  relay = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", c => chunks.push(c))
    req.on("end", () => {
      const entry: Seen = {
        method: req.method || "",
        url: req.url || "",
        token: req.headers["x-pes-relay-token"] as string | undefined,
        referer: req.headers.referer,
        body: Buffer.concat(chunks).toString("utf8"),
      }
      seen.push(entry)
      reply(entry, res)
    })
  })
  await new Promise<void>(resolve => relay.listen(0, "127.0.0.1", resolve))
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise(resolve => relay.close(resolve))
})

beforeEach(() => {
  seen = []
  reply = (_req, res) => res.writeHead(200, { "content-type": "application/xml" }).end(XML)
  vi.stubEnv("LAW_OC", "real-env-key-123")
  vi.stubEnv("KOREAN_LAW_API_KEY", "real-env-key-456")
  vi.stubEnv("PES_RELAY_URL", `${relayUrl}/`)
  vi.stubEnv("PES_RELAY_TOKEN", "tok-1")
  vi.stubEnv("PES_RELAY_LAW_KEYS", "1")
})
afterEach(() => {
  disablePesRelay()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe("PES 중계 모드 — 요청 다시 쓰기", () => {
  it("법제처 요청을 중계 주소로 바꾸고 토큰과 자리표시 OC 를 싣는다 (환경 변수·인자 키 무시)", async () => {
    expect(enablePesRelay()).toBe(true)
    const text = await new LawApiClient({ apiKey: "ctor-key-789" }).searchLaw("민법", "override-key-000")
    expect(text).toContain("LawSearch")
    expect(seen).toHaveLength(1)
    const url = new URL(seen[0].url, relayUrl)
    expect(url.pathname).toBe("/law/https/www.law.go.kr/DRF/lawSearch.do")
    expect(url.searchParams.get("OC")).toBe("__PES_KEY_0__")
    expect(url.searchParams.get("target")).toBe("law")
    expect(seen[0].token).toBe("tok-1")
    expect(seen[0].referer).toBe("https://www.law.go.kr/")
    expect(seen[0].url).not.toMatch(/real-env-key|ctor-key|override-key/)
  })

  it("키 없는 기관 요청(POST)도 방식·본문 그대로 중계로 보낸다", async () => {
    enablePesRelay()
    reply = (_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(`{"status":"SUCCESS"}`)
    const response = await fetchWithRetry("https://taxlaw.nts.go.kr/action.do", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "actionId=A&paramData=%7B%7D",
    })
    expect(await response.text()).toContain("SUCCESS")
    expect(seen[0]).toMatchObject({
      method: "POST",
      url: "/law/https/taxlaw.nts.go.kr/action.do",
      body: "actionId=A&paramData=%7B%7D",
      token: "tok-1",
    })
  })

  it("기관이 아닌 곳은 중계로 보내지 않는다", async () => {
    enablePesRelay()
    const direct = vi.fn(async () => new Response("ok"))
    vi.stubGlobal("fetch", direct)
    await relayFetch("https://api.github.com/repos/x/y/releases/latest", { headers: { accept: "*/*" } })
    expect(direct).toHaveBeenCalledTimes(1)
    const [url, init] = direct.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://api.github.com/repos/x/y/releases/latest")
    expect(new Headers(init.headers).has("x-pes-relay-token")).toBe(false)
  })

  it("기관 주소로 넘기는 3xx 는 Location 을 다시 중계 주소로 바꿔 따라간다", async () => {
    enablePesRelay()
    reply = (req, res) => req.url.includes("/first")
      ? res.writeHead(302, { location: "/DRF/second.do?OC=__PES_KEY_0__" }).end()
      : res.writeHead(200, { "content-type": "application/xml" }).end(XML)
    const response = await relayFetch("https://www.law.go.kr/first")
    expect(response.status).toBe(200)
    expect(seen.map(s => s.url)).toEqual([
      "/law/https/www.law.go.kr/first",
      "/law/https/www.law.go.kr/DRF/second.do?OC=__PES_KEY_0__",
    ])
    expect(seen[1].token).toBe("tok-1")
  })

  it("redirect: manual 이면 3xx 를 그대로 돌려준다", async () => {
    enablePesRelay()
    reply = (_req, res) => res.writeHead(302, { location: "https://taxlaw.nts.go.kr/qt/x.do" }).end()
    const response = await relayFetch("https://www.law.go.kr/first", { redirect: "manual" })
    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe("https://taxlaw.nts.go.kr/qt/x.do")
    expect(seen).toHaveLength(1)
  })

  it("중계 모드에서는 별도 HTTPS 프록시 설정을 쓰지 않는다", () => {
    vi.stubEnv("LAW_EXTERNAL_HTTPS_PROXY", "http://127.0.0.1:9")
    expect(getExternalHttpsProxyConfig()).not.toBeNull()
    enablePesRelay()
    expect(getExternalHttpsProxyConfig()).toBeNull()
  })
})

describe("PES 중계 모드 — 키 0개 · 중계 오류", () => {
  it.each(["0", "", "abc", "-1"])("키 수 %j 이면 기관을 부르지 않고 안내한다", async (count) => {
    vi.stubEnv("PES_RELAY_LAW_KEYS", count)
    enablePesRelay()
    expect(() => pesRelayKey()).toThrow(NO_KEY)
    await expect(new LawApiClient({ apiKey: "k" }).searchLaw("민법")).rejects.toThrow(NO_KEY)
    await expect(fetchWithRetry("https://www.law.go.kr/x")).rejects.toBeInstanceOf(PesRelayError)
    expect(seen).toHaveLength(0)
  })

  it("X-PES-Relay-Error 응답은 error 글로 끝내고 다시 시도하지 않는다", async () => {
    enablePesRelay()
    reply = (_req, res) => res
      .writeHead(409, { "content-type": "application/json", "x-pes-relay-error": "1" })
      .end(JSON.stringify({ error: "PES 에 법령 키가 없어요 (중계)" }))
    await expect(new LawApiClient({ apiKey: "k" }).searchLaw("민법")).rejects.toThrow("PES 에 법령 키가 없어요 (중계)")
    expect(seen).toHaveLength(1)
  })

  it("기관이 준 4xx·재시도 대상 응답은 중계 오류로 보지 않는다", async () => {
    enablePesRelay()
    reply = (_req, res) => res.writeHead(403, { "content-type": "text/plain" }).end("forbidden")
    const response = await fetchWithRetry("https://www.law.go.kr/x")
    expect(response.status).toBe(403)
  })
})

describe("PES 중계 모드 — korean-law CLI", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(process, "exit").mockImplementation((code) => { throw new Error(`CLI exited ${code}`) })
  })
  const run = (...args: string[]) =>
    createProgram().exitOverride().configureOutput({ writeErr: () => {} }).parseAsync(["node", "cli", ...args])
  const errors = () => vi.mocked(console.error).mock.calls.flat().join("\n")

  it("도구 호출이 모두 중계로 가고 --apiKey·LAW_OC 를 쓰지 않는다", async () => {
    expect(enablePesRelayForCli()).toBe(true)
    await run("search_law", "--query", "민법", "--apiKey", "cli-option-key").catch(() => {})
    expect(seen.length).toBeGreaterThan(0)
    for (const req of seen) {
      expect(req.url.startsWith("/law/https/www.law.go.kr/DRF/")).toBe(true)
      expect(new URL(req.url, relayUrl).searchParams.get("OC")).toBe("__PES_KEY_0__")
      expect(req.token).toBe("tok-1")
      expect(req.url).not.toMatch(/cli-option-key|real-env-key/)
    }
  })

  it("키 수가 없으면 안내하고 0 이 아닌 코드로 끝낸다 (기관 호출 없음)", async () => {
    vi.stubEnv("PES_RELAY_LAW_KEYS", undefined)
    enablePesRelayForCli()
    await expect(run("search_law", "--query", "민법")).rejects.toThrow("CLI exited 1")
    expect(errors()).toContain(NO_KEY)
    expect(seen).toHaveLength(0)
  })

  it("중계 오류는 error 글을 보여 주고 0 이 아닌 코드로 끝낸다", async () => {
    enablePesRelayForCli()
    reply = (_req, res) => res
      .writeHead(401, { "content-type": "application/json", "x-pes-relay-error": "1" })
      .end(JSON.stringify({ error: "토큰이 맞지 않아요" }))
    await expect(run("search_law", "--query", "민법")).rejects.toThrow("CLI exited 1")
    expect(errors()).toContain("토큰이 맞지 않아요")
    // 같은 주소를 다시 부르지 않는다(search_law 는 시행예정 조회를 함께 띄우므로 주소는 둘까지)
    expect(new Set(seen.map(s => s.url)).size).toBe(seen.length)
    expect(seen.length).toBeLessThanOrEqual(2)
  })
})

describe("중계 모드가 아닐 때 — 기존 동작 그대로", () => {
  const stubUpstream = () => {
    const upstream = vi.fn(async () => new Response(XML, { status: 200, headers: { "content-type": "application/xml" } }))
    vi.stubGlobal("fetch", upstream)
    return upstream
  }

  it("PES_RELAY_URL 이 없으면 켜지지 않고 LAW_OC 로 법제처를 직접 부른다", async () => {
    vi.stubEnv("PES_RELAY_URL", "")
    expect(enablePesRelay()).toBe(false)
    expect(pesRelayKey()).toBeUndefined()
    const upstream = stubUpstream()
    await new LawApiClient({ apiKey: "ctor-key" }).searchLaw("민법")
    const [url, init] = upstream.mock.calls[0] as unknown as [string, RequestInit]
    expect(url.startsWith("https://www.law.go.kr/DRF/lawSearch.do?")).toBe(true)
    expect(new URL(url).searchParams.get("OC")).toBe("real-env-key-123")
    expect(new Headers(init.headers).has("x-pes-relay-token")).toBe(false)
    expect(init.redirect).toBeUndefined()
    expect(seen).toHaveLength(0)
  })

  it("진입점이 켜지 않으면(MCP 서버) PES_RELAY_URL 이 있어도 달라지지 않는다", async () => {
    const upstream = stubUpstream()
    await new LawApiClient({ apiKey: "ctor-key" }).searchLaw("민법", "override-key")
    const [url] = upstream.mock.calls[0] as unknown as [string]
    expect(new URL(url).host).toBe("www.law.go.kr")
    expect(new URL(url).searchParams.get("OC")).toBe("override-key")
    expect(seen).toHaveLength(0)
  })
})
