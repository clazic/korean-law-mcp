/**
 * PES 중계 모드 — pes-bridge 가 띄운 로컬 중계로 기관 요청을 보낸다 (도구 이름 `law`).
 *
 * 외부 AI(pes-bridge)가 `korean-law` CLI 를 돌릴 때는 CLI 가 법제처 키(OC)를 받지 않는다.
 * 키는 중계가 갖고 있고, CLI 는 자리표시 `__PES_KEY_0__` 를 OC 로 실어 중계로 보낸다.
 * 규약 원문: pes-bridge `RELAY.md`.
 *
 * - CLI 진입점(`cli.ts` main)이 `enablePesRelay()` 를 불러야만 켜진다. MCP 서버(STDIO·HTTP)는
 *   부르지 않으므로 `PES_RELAY_URL` 이 있어도 동작이 달라지지 않는다.
 * - `PES_RELAY_URL` 이 없으면 `relayFetch` 는 `fetch` 그대로이고 `pesRelayKey` 는 undefined 다.
 * - 키 풀을 돌려 쓰는 코드가 없으므로 자리표시는 0번 하나만 쓴다.
 */

const RELAY_TOOL = "law"
const KEY_PLACEHOLDER = "__PES_KEY_0__"
const NO_KEY_MESSAGE = "PES 에 법령 키가 없어요. PES 「조사 도구 · 그림 키」에서 키를 넣으세요."
const MAX_REDIRECTS = 5

/** 중계가 낸 오류(401·403·409, `X-PES-Relay-Error: 1`)와 키 0개 — 다시 시도하지 않는다 */
export class PesRelayError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PesRelayError"
  }
}

interface RelayState {
  base: string
  token: string
  keys: number
  onFatal?: (message: string) => void
  /** 한 번 난 중계 오류 — 그 뒤 요청은 중계를 부르지 않고 같은 오류로 끝난다 */
  failed?: string
}

let state: RelayState | null = null

function fail(relay: RelayState, message: string): never {
  relay.failed = message
  try {
    relay.onFatal?.(message)
  } finally {
    // onFatal 이 프로세스를 끝내지 않아도(테스트·라이브러리 사용) 호출 흐름은 여기서 끊는다
    throw new PesRelayError(message)
  }
}

/**
 * 환경 변수로 중계 모드를 켠다. `PES_RELAY_URL` 이 없으면 끈 채로 false.
 * @param onFatal 중계 오류·키 0개일 때 부른다(CLI: 글을 보여 주고 0 이 아닌 코드로 끝). 그 뒤 `PesRelayError` 를 던진다
 */
export function enablePesRelay(
  onFatal?: (message: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const base = (env.PES_RELAY_URL || "").trim().replace(/\/+$/, "")
  if (!base) {
    state = null
    return false
  }
  const count = Number((env.PES_RELAY_LAW_KEYS || "").trim() || "0")
  state = {
    base,
    token: env.PES_RELAY_TOKEN || "",
    keys: Number.isInteger(count) && count > 0 ? count : 0,
    onFatal,
  }
  return true
}

export function disablePesRelay(): void {
  state = null
}

export function pesRelayActive(): boolean {
  return state !== null
}

/**
 * 중계 모드의 OC 값(자리표시). 중계 모드가 아니면 undefined — 호출부는 기존 키 결정으로 넘어간다.
 * 키 수가 0 이면 기관을 부르지 않고 안내하고 끝낸다.
 */
export function pesRelayKey(): string | undefined {
  if (!state) return undefined
  if (state.failed) return fail(state, state.failed)
  if (state.keys === 0) return fail(state, NO_KEY_MESSAGE)
  return KEY_PLACEHOLDER
}

/** 중계로 보낼 기관 호스트: 법제처(law.go.kr 계열) · 국세법령정보(nts.go.kr 계열, 키 없는 본문 조회) */
function isAgencyHost(hostname: string): boolean {
  return /(^|\.)(law|nts)\.go\.kr$/i.test(hostname)
}

/** `<scheme>://<host>/<path>?<query>` → `{중계}/law/<scheme>/<host>/<path>?<query>`. 기관 주소가 아니면 null */
function toRelayUrl(base: string, url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const scheme = parsed.protocol.replace(/:$/, "")
  if ((scheme !== "http" && scheme !== "https") || !isAgencyHost(parsed.hostname)) return null
  return `${base}/${RELAY_TOOL}/${scheme}/${parsed.host}${parsed.pathname}${parsed.search}`
}

async function relayErrorText(response: Response): Promise<string> {
  try {
    const body = JSON.parse(await response.text()) as { error?: unknown }
    if (typeof body?.error === "string" && body.error) return body.error
  } catch {
    // 본문이 JSON 이 아니면 아래 기본 문구
  }
  return `PES 중계 오류 (HTTP ${response.status})`
}

/**
 * 기관으로 가는 요청의 단일 통로. 중계 모드가 아니면 `fetch` 와 같다.
 *
 * 중계는 주소 넘김(3xx)을 따라가지 않고 그대로 돌려준다. 호출부가 `redirect: "manual"` 을
 * 주지 않았으면 여기서 `Location` 을 원래 주소 기준으로 풀어 다시 중계 주소로 바꿔 요청한다.
 */
export async function relayFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (!state) return fetch(url, init)
  const relay = state

  let target = url
  let current = init
  for (let hop = 0; ; hop++) {
    const wrapped = toRelayUrl(relay.base, target)
    // 기관이 아닌 곳은 중계로 보내지 않는다
    if (!wrapped) return fetch(target, current)
    if (relay.failed) return fail(relay, relay.failed)
    if (relay.keys === 0) return fail(relay, NO_KEY_MESSAGE)

    const headers = new Headers(current.headers)
    headers.set("X-PES-Relay-Token", relay.token)
    const response = await fetch(wrapped, { ...current, headers, redirect: "manual" })

    if (response.headers.get("x-pes-relay-error") === "1") {
      return fail(relay, await relayErrorText(response))
    }

    const location = response.headers.get("location")
    const isRedirect = response.status >= 300 && response.status < 400 && Boolean(location)
    if (!isRedirect || init.redirect === "manual" || hop >= MAX_REDIRECTS) return response

    void response.body?.cancel().catch(() => {})
    target = new URL(location!, target).toString()
    // fetch 의 넘김 규칙: 303 은 언제나, 301·302 는 POST 일 때 GET 으로 바꾸고 본문을 버린다
    const method = (current.method || "GET").toUpperCase()
    if (response.status === 303 ? method !== "GET" && method !== "HEAD" : (response.status === 301 || response.status === 302) && method === "POST") {
      const next = new Headers(current.headers)
      next.delete("content-type")
      next.delete("content-length")
      current = { ...current, method: "GET", body: undefined, headers: next }
    }
  }
}
