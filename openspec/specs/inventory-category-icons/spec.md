## ADDED Requirements

### Requirement: Category icon displayed on every inventory item
The system SHALL display an emoji icon representing the item's category wherever an inventory item name appears in the UI — in the inventory catalog table, the sale-panel consumables catalog, and the session item-picker dropdown.

#### Scenario: Known category shows mapped icon
- **WHEN** an inventory item belongs to a known category (Beverages, Food, Cigarettes, Refill Sheesha, Arcade)
- **THEN** the corresponding emoji icon is shown immediately before or alongside the item name in every listing context

#### Scenario: Unknown or custom category shows fallback icon
- **WHEN** an inventory item's category does not match any entry in the predefined icon map
- **THEN** a generic fallback icon (📦) is displayed

#### Scenario: Icon appears in inventory panel table
- **WHEN** the inventory catalog table is rendered
- **THEN** each row shows the category icon in the Category column alongside the category name text

#### Scenario: Icon appears in sale-panel catalog cards
- **WHEN** the consumables catalog grid is rendered in the sale panel
- **THEN** each item card shows the category icon prominently alongside the item name

#### Scenario: Icon appears in session item-picker
- **WHEN** the item-picker dropdown is rendered in the session consumables section
- **THEN** each option in the dropdown includes the category icon prefix before the item name

### Requirement: Cigarettes category receives an amber accent
The system SHALL apply a distinct amber/warning visual treatment to any item whose category is "Cigarettes" so that cigarette items are immediately recognisable on a busy screen.

#### Scenario: Cigarette items have amber accent in catalog
- **WHEN** a cigarette item is displayed in the sale-panel catalog or inventory table
- **THEN** the category icon or item name row shows an amber colour accent (distinct from the default green/neutral styling)

#### Scenario: Non-cigarette items have no amber accent
- **WHEN** any item with a category other than "Cigarettes" is displayed
- **THEN** no amber accent is applied; normal styling is used
