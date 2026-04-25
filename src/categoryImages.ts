import hookahIcon from "../images/Icon.png";
import beverageIcon from "../images/Beverage.jpg";
import flavourIcon from "../images/flavour.png";
import foodIcon from "../images/food.png";

export const CATEGORY_IMAGES: Record<string, string> = {
  "Beverages": beverageIcon,
  "Food": foodIcon,
  "Herbal Pot": hookahIcon,
  "Refill Sheesha": hookahIcon,
  "Herbal Pot Flavour": flavourIcon,
  "Herbal Pot Flavours": flavourIcon,
  "Herbal Flavour": flavourIcon,
};

export function getCategoryImage(category: string): string | undefined {
  return CATEGORY_IMAGES[category];
}
