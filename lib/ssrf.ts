import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { promisify } from "node:util";
import { BlockList, isIP } from "node:net";

/**
 * Proteção contra SSRF no encaminhamento.
 *
 * `validateForwardUrl` roda ao salvar a URL e antes de cada envio.
 * `safeLookup` é usado como `lookup` do socket no envio, para que o IP conferido seja
 * exatamente o IP conectado (evita DNS rebinding entre a checagem e o fetch).
 */

const blocked = new BlockList();

// IPv4
blocked.addSubnet("0.0.0.0", 8, "ipv4"); // "esta rede"
blocked.addSubnet("10.0.0.0", 8, "ipv4"); // privado
blocked.addSubnet("100.64.0.0", 10, "ipv4"); // CGNAT
blocked.addSubnet("127.0.0.0", 8, "ipv4"); // loopback
blocked.addSubnet("169.254.0.0", 16, "ipv4"); // link-local (inclui 169.254.169.254, metadata da cloud)
blocked.addSubnet("172.16.0.0", 12, "ipv4"); // privado
blocked.addSubnet("192.0.0.0", 24, "ipv4"); // IETF protocol assignments
blocked.addSubnet("192.168.0.0", 16, "ipv4"); // privado
blocked.addSubnet("198.18.0.0", 15, "ipv4"); // benchmark
blocked.addSubnet("224.0.0.0", 4, "ipv4"); // multicast
blocked.addSubnet("240.0.0.0", 4, "ipv4"); // reservado + broadcast

// IPv6
blocked.addAddress("::", "ipv6"); // não especificado
blocked.addAddress("::1", "ipv6"); // loopback
blocked.addSubnet("fc00::", 7, "ipv6"); // unique local
blocked.addSubnet("fe80::", 10, "ipv6"); // link-local
blocked.addSubnet("ff00::", 8, "ipv6"); // multicast
blocked.addSubnet("64:ff9b::", 96, "ipv6"); // NAT64 (pode apontar para IPv4 interno)
blocked.addSubnet("2002::", 16, "ipv6"); // 6to4 (embute IPv4)
blocked.addSubnet("fd00:ec2::", 32, "ipv6"); // metadata da AWS em IPv6

/** IPv4 embutido em IPv6 (::ffff:a.b.c.d ou ::a.b.c.d), se houver. */
function embeddedIPv4(address: string): string | null {
  const match = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (match) return match[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  if (family === 4) return blocked.check(address, "ipv4");
  const v4 = embeddedIPv4(address);
  if (v4) return blocked.check(v4, "ipv4");
  return blocked.check(address, "ipv6");
}

export class ForwardUrlError extends Error {}

const lookupAll = promisify(dnsLookup) as (
  hostname: string,
  options: { all: true },
) => Promise<LookupAddress[]>;

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

export interface ValidateOptions {
  appUrl: string;
  requireHttps: boolean;
  resolve?: (hostname: string) => Promise<LookupAddress[]>;
}

/** Lança `ForwardUrlError` com uma mensagem em pt-BR se a URL não puder ser usada. */
export async function validateForwardUrl(raw: string, options: ValidateOptions): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ForwardUrlError("URL inválida.");
  }

  if (url.protocol !== "https:" && !(url.protocol === "http:" && !options.requireHttps)) {
    throw new ForwardUrlError(options.requireHttps ? "A URL precisa usar https." : "A URL precisa usar http ou https.");
  }
  if (url.username || url.password) {
    throw new ForwardUrlError("A URL não pode conter usuário ou senha.");
  }

  const hostname = stripBrackets(url.hostname).toLowerCase().replace(/\.$/, "");
  const appHost = new URL(options.appUrl).hostname.toLowerCase();
  if (hostname === appHost || hostname.endsWith(`.${appHost}`)) {
    throw new ForwardUrlError("A URL não pode apontar para o próprio Hookbox.");
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".internal")) {
    throw new ForwardUrlError("A URL aponta para um endereço interno.");
  }

  let addresses: LookupAddress[];
  if (isIP(hostname)) {
    addresses = [{ address: hostname, family: isIP(hostname) }];
  } else {
    try {
      addresses = await (options.resolve ?? ((h) => lookupAll(h, { all: true })))(hostname);
    } catch {
      throw new ForwardUrlError("Não foi possível resolver o host da URL.");
    }
  }
  if (addresses.length === 0 || addresses.some((a) => isBlockedAddress(a.address))) {
    throw new ForwardUrlError("A URL aponta para um endereço interno ou reservado.");
  }
  return url;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * `lookup` para o socket do envio: resolve e recusa se algum IP for bloqueado.
 * Compatível com `net.connect({ lookup })` / `undici.Agent({ connect: { lookup } })`.
 */
export function safeLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  const opts = options ?? {};
  dnsLookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return callback(err, opts.all ? [] : "", 0);
    const list = addresses as LookupAddress[];
    if (list.length === 0 || list.some((a) => isBlockedAddress(a.address))) {
      const error: NodeJS.ErrnoException = new Error(`Endereço bloqueado para ${hostname}`);
      error.code = "EBLOCKED";
      return callback(error, opts.all ? [] : "", 0);
    }
    if (opts.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}
