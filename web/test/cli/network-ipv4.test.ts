// Port of IPv4Tests (Tests/NetSketchCLITests/NetworkTests.swift), plus edge cases.

import { IPv4, IPv4Prefix } from "../../src/cli/sim/ipv4";

describe("IPv4", () => {
  test("parsing", () => {
    expect(IPv4.parse("192.168.1.10")?.description).toBe("192.168.1.10");
    expect(IPv4.parse("192.168.1")).toBeNull();
    expect(IPv4.parse("256.1.1.1")).toBeNull();
    expect(IPv4.parse("1.2.3.x")).toBeNull();
    expect(IPv4.parse("255.255.255.252")?.prefixLength).toBe(30);
    expect(IPv4.parse("255.0.255.0")?.prefixLength).toBeNull();
    const prefix = IPv4Prefix.fromAddressMask("10.0.12.1", "255.255.255.252");
    expect(prefix?.description).toBe("10.0.12.1/30");
    expect(prefix?.network.description).toBe("10.0.12.0");
    expect(prefix?.contains(IPv4.parse("10.0.12.2")!)).toBe(true);
    expect(prefix?.contains(IPv4.parse("10.0.12.4")!)).toBe(false);
    expect(IPv4Prefix.fromCIDR("10.0.12.0/30")?.isHostAddress).toBe(false);
    expect(IPv4Prefix.fromCIDR("0.0.0.0/0")?.length).toBe(0);
  });

  test("strict dotted decimal", () => {
    for (const bad of ["", "1.2.3.4.5", "1..3.4", "1.2.3.", " 1.2.3.4", "1.2.3.4 ", "+1.2.3.4", "1.2.3.0004", "١.2.3.4"]) {
      expect(IPv4.parse(bad), bad).toBeNull();
    }
    expect(IPv4.parse("001.002.003.004")?.description).toBe("1.2.3.4");
    expect(IPv4.parse("255.255.255.255")?.value).toBe(0xffffffff);
    expect(IPv4.parse("0.0.0.0")?.value).toBe(0);
  });

  test("masks and prefix lengths", () => {
    expect(IPv4.mask(0).description).toBe("0.0.0.0");
    expect(IPv4.mask(-3).description).toBe("0.0.0.0");
    expect(IPv4.mask(1).description).toBe("128.0.0.0");
    expect(IPv4.mask(24).description).toBe("255.255.255.0");
    expect(IPv4.mask(32).description).toBe("255.255.255.255");
    expect(IPv4.mask(40).description).toBe("255.255.255.255");
    for (let length = 0; length <= 32; length++) expect(IPv4.mask(length).prefixLength).toBe(length);
    expect(IPv4.parse("0.255.255.255")?.prefixLength).toBeNull();
  });

  test("prefixes", () => {
    expect(IPv4Prefix.fromCIDR("10.0.0.1/33")).toBeNull();
    expect(IPv4Prefix.fromCIDR("10.0.0.1/")).toBeNull();
    expect(IPv4Prefix.fromCIDR("10.0.0.1/024")).toBeNull();
    expect(IPv4Prefix.fromCIDR("10.0.0.1/8/8")).toBeNull();
    expect(IPv4Prefix.fromCIDR("10.0.0.1")).toBeNull();
    expect(IPv4Prefix.fromAddressMask("10.0.0.1", "255.0.255.0")).toBeNull();
    expect(IPv4Prefix.fromWords(["10.0.0.1/8"])?.description).toBe("10.0.0.1/8");
    expect(IPv4Prefix.fromWords(["10.0.0.1", "255.0.0.0"])?.description).toBe("10.0.0.1/8");
    expect(IPv4Prefix.fromWords(["10.0.0.1", "255.0.0.0", "x"])).toBeNull();
    expect(IPv4Prefix.fromWords([])).toBeNull();

    const prefix = IPv4Prefix.fromCIDR("192.168.1.130/25")!;
    expect(prefix.mask.description).toBe("255.255.255.128");
    expect(prefix.network.description).toBe("192.168.1.128");
    expect(prefix.broadcast.description).toBe("192.168.1.255");
    expect(prefix.networkPrefix.description).toBe("192.168.1.128/25");
    expect(prefix.isHostAddress).toBe(true);
    expect(IPv4Prefix.fromCIDR("192.168.1.255/24")?.isHostAddress).toBe(false);
    expect(IPv4Prefix.fromCIDR("10.0.0.0/31")?.isHostAddress).toBe(true);
    expect(IPv4Prefix.fromCIDR("10.0.0.0/32")?.isHostAddress).toBe(true);

    const all = IPv4Prefix.fromCIDR("0.0.0.0/0")!;
    expect(all.contains(IPv4.parse("255.255.255.255")!)).toBe(true);
    expect(all.broadcast.description).toBe("255.255.255.255");
    expect(new IPv4Prefix(IPv4.parse("1.2.3.4")!, 99).length).toBe(32);
    expect(new IPv4Prefix(IPv4.parse("1.2.3.4")!, -1).length).toBe(0);
    expect(prefix.equals(IPv4Prefix.fromCIDR("192.168.1.130/25"))).toBe(true);
    expect(prefix.equals(prefix.networkPrefix)).toBe(false);
    expect(`${prefix}`).toBe("192.168.1.130/25");
  });
});
