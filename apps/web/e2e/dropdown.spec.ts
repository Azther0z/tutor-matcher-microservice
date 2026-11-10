import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/discovery/learning-areas", (route) =>
    route.fulfill({
      json: {
        items: [
          { id: "mathematics", label: "Mathematics" },
          { id: "science", label: "Science" },
        ],
      },
    }),
  );
  await page.route("**/api/discovery/price-range", (route) =>
    route.fulfill({
      json: { minimum: { amount: "100.00" }, maximum: { amount: "800.00" } },
    }),
  );
  await page.route("**/api/discovery/tutors?**", (route) =>
    route.fulfill({
      json: {
        items: [],
        pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
      },
    }),
  );
});

test("custom dropdowns preserve defaults and submit selected filter values", async ({
  page,
}) => {
  await page.goto("/discover?sort=PRICE_DESC");
  await expect(page.locator("select")).toHaveCount(0);
  await expect(page.getByRole("combobox")).toHaveCount(3);
  await expect(page.getByLabel("Sort subjects")).toHaveText(
    "Price: high to low",
  );

  await page.getByLabel("Learning area").click();
  await page.getByRole("option", { name: "Mathematics", exact: true }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(page.getByLabel("Learning area")).toBeFocused();

  await page.getByLabel("Minimum rating").click();
  await page
    .getByRole("option", { name: "4.5 stars & up", exact: true })
    .click();
  await page.getByLabel("Sort subjects").click();
  await expect(
    page.getByRole("option", { name: "Price: high to low", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("option", { name: "Top rated", exact: true }).click();
  await page.getByRole("button", { name: "Search", exact: true }).click();

  await expect(page).toHaveURL(/learningArea=mathematics/);
  const parameters = new URL(page.url()).searchParams;
  expect(parameters.get("minRating")).toBe("4.5");
  expect(parameters.get("sort")).toBe("TOP_RATED");
  await expect(page.getByLabel("Minimum rating")).toHaveText("4.5 stars & up");
});

test("keyboard navigation, typeahead, Escape and Tab work without submitting the form", async ({
  page,
}) => {
  await page.goto("/discover");
  const sort = page.getByLabel("Sort subjects");
  await expect(sort).toBeEnabled();
  await sort.press("ArrowDown");
  await expect(sort).toHaveAttribute("aria-expanded", "true");
  await sort.press("End");
  await sort.press("Enter");
  await expect(sort).toHaveText("Top rated");
  await expect(page).toHaveURL(/\/discover$/);

  await sort.press("Home");
  await sort.press("Escape");
  await expect(sort).toHaveText("Top rated");
  await expect(sort).toHaveAttribute("aria-expanded", "false");
  await expect(sort).toBeFocused();

  await sort.press("p");
  await sort.press("p");
  await sort.press("Enter");
  await expect(sort).toHaveText("Price: high to low");
  await sort.press("ArrowDown");
  await sort.press("Home");
  await sort.press("Tab");
  await expect(sort).toHaveText("Recommended");
  await expect(sort).toHaveAttribute("aria-expanded", "false");
  await expect(
    page.getByRole("button", { name: "Search", exact: true }),
  ).toBeFocused();
});

test("outside clicks and switching dropdowns dismiss the previous menu", async ({
  page,
}) => {
  await page.goto("/discover");
  await page.getByLabel("Learning area").click();
  await expect(page.getByRole("listbox")).toHaveCount(1);
  await page.getByLabel("Minimum rating").click();
  await expect(page.getByLabel("Learning area")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(page.getByRole("listbox")).toHaveCount(1);
  await page.getByRole("heading", { name: "Find your tutor" }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
});

test("a catalogue outage disables custom dropdowns through their fieldset", async ({
  page,
}) => {
  await page.route("**/api/discovery/learning-areas", (route) =>
    route.fulfill({
      status: 503,
      json: {
        code: "SERVICE_UNAVAILABLE",
        message: "Learning areas are temporarily unavailable.",
      },
    }),
  );
  await page.goto("/discover");
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Search is unavailable right now." }),
  ).toBeVisible();
  for (const label of ["Learning area", "Minimum rating", "Sort subjects"]) {
    await expect(page.getByLabel(label)).toBeDisabled();
  }
  await expect(page.getByRole("listbox")).toHaveCount(0);
});

test("dropdown menus fit a mobile viewport and scroll through long option lists", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto("/discover");
  await page.getByLabel("Minimum rating").click();
  const menu = page.getByRole("listbox");
  await expect(menu).toBeVisible();
  const box = await menu.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(667);
  await page.getByRole("option", { name: "5 stars & up", exact: true }).click();
  await expect(page.getByLabel("Minimum rating")).toHaveText("5 stars & up");
});
