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

test("discovery controls preserve defaults and apply selected filter values", async ({
  page,
}) => {
  await page.goto("/discover?sort=PRICE_DESC");
  await expect(page.locator("select")).toHaveCount(0);
  await expect(page.getByRole("combobox")).toHaveCount(2);
  await expect(page.getByLabel("Sort")).toHaveText("Price: high to low");

  await page.getByLabel("Learning area").click();
  await page.getByRole("option", { name: "Mathematics", exact: true }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(page).toHaveURL(/learningArea=mathematics/);

  const fourStars = page.getByLabel("Minimum rating").getByRole("button", {
    name: "4 stars and up",
  });
  await fourStars.click();
  await expect(page).toHaveURL(/minRating=4/);
  await page.getByLabel("Sort").click();
  await expect(
    page.getByRole("option", { name: "Price: high to low", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("option", { name: "Top rated", exact: true }).click();
  await expect(page).toHaveURL(/sort=TOP_RATED/);

  await expect(page).toHaveURL(/learningArea=mathematics/);
  const parameters = new URL(page.url()).searchParams;
  expect(parameters.get("minRating")).toBe("4");
  expect(parameters.get("sort")).toBe("TOP_RATED");
  await expect(
    page.getByLabel("Minimum rating").getByRole("button", {
      name: "4 stars and up",
    }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("keyboard navigation, typeahead, Escape and Tab work without submitting the form", async ({
  page,
}) => {
  await page.goto("/discover");
  const sort = page.getByLabel("Sort");
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
  await expect(page).toHaveURL(/sort=PRICE_DESC/);
  await sort.press("Home");
  await sort.press("Enter");
  await expect(sort).toHaveText("Recommended");
  await expect(page).toHaveURL(/\/discover$/);

  const learningArea = page.getByRole("combobox", { name: "Learning area" });
  await learningArea.press("ArrowDown");
  await expect(learningArea).toHaveAttribute("aria-expanded", "true");
  await learningArea.press("Tab");
  await expect(learningArea).toHaveText("All learning areas");
  await expect(learningArea).toHaveAttribute("aria-expanded", "false");
  await expect(
    page.getByRole("button", { name: "1 star and up" }),
  ).toBeFocused();
  await expect(page).toHaveURL(/\/discover$/);
});

test("outside clicks and switching dropdowns dismiss the previous menu", async ({
  page,
}) => {
  await page.goto("/discover");
  await page.getByLabel("Learning area").click();
  await expect(page.getByRole("listbox")).toHaveCount(1);
  await page.getByLabel("Sort").click();
  await expect(page.getByLabel("Learning area")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(page.getByRole("listbox")).toHaveCount(1);
  await page.getByRole("heading", { name: "Find a tutor" }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
});

test("a catalogue outage disables discovery filters and sorting", async ({
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
  await expect(page.getByLabel("Learning area")).toBeDisabled();
  await expect(page.getByLabel("Sort")).toBeDisabled();
  const ratingButtons = page
    .getByLabel("Minimum rating")
    .getByRole("button");
  await expect(ratingButtons).toHaveCount(5);
  for (let index = 0; index < 5; index += 1) {
    await expect(ratingButtons.nth(index)).toBeDisabled();
  }
  await expect(page.getByRole("listbox")).toHaveCount(0);
});

test("dropdown menus fit a mobile viewport and scroll through long option lists", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.route("**/api/discovery/learning-areas", (route) =>
    route.fulfill({
      json: {
        items: Array.from({ length: 24 }, (_, index) => ({
          id: `area-${index + 1}`,
          label: `Learning area ${index + 1}`,
        })),
      },
    }),
  );
  await page.goto("/discover");
  await page.getByLabel("Learning area").click();
  const menu = page.getByRole("listbox");
  await expect(menu).toBeVisible();
  const box = await menu.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(667);
  await expect
    .poll(() => menu.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true);
  await page
    .getByRole("option", { name: "Learning area 24", exact: true })
    .click();
  await expect(page).toHaveURL(/learningArea=area-24/);
});
