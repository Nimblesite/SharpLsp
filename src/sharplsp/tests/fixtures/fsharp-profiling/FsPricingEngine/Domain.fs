// FsPricingEngine models a retail checkout backend: catalogue CSV parsing, basket pricing
// rules, fuzzy product search, delivery-route planning and daily sales reports. Every stage is
// deliberately CPU-heavy so a sampling profiler sees a few clearly named hot methods.
// Profiling fixture for [PROFILER-SHARED-LIBRARY-VSCODE] and lspkit's [PROF-TESTING].

module FsPricingEngine.Domain

open System

/// Stock-keeping unit: a single-case union so it prints and compares structurally.
type Sku = Sku of string

type Product =
    { Sku: Sku
      Name: string
      Price: decimal
      Stock: int
      Category: string }

type BasketLine = { Product: Sku; Quantity: int }

type Discount =
    | PercentOff of decimal
    | BuyXGetY of buy: int * free: int
    | Bundle of Sku list * price: decimal
    | Tiered of (int * decimal) list

type Order = { Id: int; PlacedOn: DateTime; Lines: BasketLine list }
