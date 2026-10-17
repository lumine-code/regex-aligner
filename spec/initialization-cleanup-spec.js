describe("regex-aligner initialization cleanup", () => {
  let pack;

  beforeEach(async () => {
    if (lumine.packages.isPackageLoaded("regex-aligner"))
      await lumine.packages.unloadPackage("regex-aligner", { serialize: false });
    pack = lumine.packages.loadPackage("regex-aligner");
    pack.initializeForExternalUse("workspace restoration");
  });

  afterEach(async () => {
    if (lumine.packages.isPackageLoaded("regex-aligner"))
      await lumine.packages.unloadPackage("regex-aligner", { serialize: false });
  });

  it("deactivates before activation and can activate again", async () => {
    const scope = pack.lifecycleContext.subscriptions;
    expect(pack.mainActivationStarted).toBe(false);
    await expectAsync(pack.deactivate()).toBeResolved();
    expect(scope.disposed).toBe(true);
    pack = await lumine.packages.activatePackage("regex-aligner");
    expect(pack.mainActivated).toBe(true);
    expect(pack.lifecycleContext.subscriptions).not.toBe(scope);
  });

  it("unloads before activation starts", async () => {
    expect(pack.mainInitialized).toBe(true);
    expect(pack.mainActivationStarted).toBe(false);
    await expectAsync(
      lumine.packages.unloadPackage("regex-aligner", { serialize: false }),
    ).toBeResolved();
    expect(lumine.packages.isPackageLoaded("regex-aligner")).toBe(false);
  });
});
