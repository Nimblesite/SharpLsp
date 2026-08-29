//! Medium-size mixed-language solution fixture: two C# projects joined by a
//! `ProjectReference` plus a two-file F# project, all in one `.sln` — the shape
//! of a real .NET codebase. Used by the user-session e2e tests that chain many
//! interactions against a single live workspace. [GitHub #110]

use super::*;
use std::path::{Path, PathBuf};

// ── C# sources ────────────────────────────────────────────────────
// Line/column positions below are load-bearing: `cs_med_pos` documents every
// coordinate the session tests navigate to. Editing these sources means
// re-deriving those positions.

pub const ENTITIES_CS: &str = r#"namespace Medium.Core;

/// <summary>A customer of the system.</summary>
public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public decimal Balance { get; set; }

    public bool IsVip() { return Balance > 1000m; }
}

/// <summary>Storage abstraction for customers.</summary>
public interface ICustomerRepository
{
    Customer? FindById(int id);
    void Save(Customer customer);
}

/// <summary>Lifecycle states of an order.</summary>
public enum OrderStatus
{
    Pending,
    Shipped,
    Delivered,
}

/// <summary>An order a customer placed.</summary>
public record Order(int Id, Customer Buyer, OrderStatus Status, decimal Total);
"#;

pub const PRICING_CS: &str = r"namespace Medium.Core;

/// <summary>Computes order prices and discounts.</summary>
public static class PricingEngine
{
    /// <summary>Reduces a price by a percentage.</summary>
    public static decimal ApplyDiscount(decimal price, decimal percent)
    {
        return price - (price * percent / 100m);
    }

    /// <summary>Sums the totals of a batch of orders.</summary>
    public static decimal TotalOf(IEnumerable<Order> orders)
    {
        return orders.Sum(order => order.Total);
    }
}
";

pub const CUSTOMER_SERVICE_CS: &str = r"using Medium.Core;

namespace Medium.Services;

/// <summary>In-memory customer repository.</summary>
public class CustomerService : ICustomerRepository
{
    private readonly Dictionary<int, Customer> _store = new();

    public Customer? FindById(int id)
    {
        return _store.TryGetValue(id, out var found) ? found : null;
    }

    public void Save(Customer customer)
    {
        _store[customer.Id] = customer;
    }
}
";

pub const ORDER_PROCESSOR_CS: &str = r"using Medium.Core;

namespace Medium.Services;

/// <summary>Charges customer orders with VIP discounts.</summary>
public class OrderProcessor
{
    private readonly ICustomerRepository _repository;

    public OrderProcessor(ICustomerRepository repository)
    {
        _repository = repository;
    }

    /// <summary>Charges an amount to a customer's balance.</summary>
    public decimal Charge(int customerId, decimal amount)
    {
        var customer = _repository.FindById(customerId);
        if (customer is null) { return 0m; }
        var discounted = PricingEngine.ApplyDiscount(amount, customer.IsVip() ? 10m : 0m);
        customer.Balance = customer.Balance + discounted;
        _repository.Save(customer);
        return discounted;
    }
}
";

// ── F# sources ────────────────────────────────────────────────────

pub const DOMAIN_FS: &str = r"module Medium.FsDomain.Domain

/// A product available for sale.
type Product =
    { Sku: string
      Price: decimal }

/// Payment methods accepted at checkout.
type Payment =
    | Cash
    | Card of last4: string
    | Voucher of code: string * amount: decimal

/// Deducts a payment from a price.
let charge (price: decimal) (payment: Payment) : decimal =
    match payment with
    | Cash -> price
    | Card _ -> price
    | Voucher(_, amount) -> price - amount
";

pub const CALCULATIONS_FS: &str = r"module Medium.FsDomain.Calculations

open Medium.FsDomain.Domain

/// Sums the prices of a basket of products.
let basketTotal (products: Product list) : decimal =
    products |> List.sumBy (fun product -> product.Price)

/// Charges every payment in sequence against a price.
let settle (price: decimal) (payments: Payment list) : decimal =
    payments |> List.fold (fun remaining payment -> charge remaining payment) price
";

// ── Navigation positions (0-based line, character) ────────────────

/// Positions inside the C# sources of the medium workspace.
pub mod cs_med_pos {
    /// `Customer` class name in Entities.cs `public class Customer`.
    pub const CUSTOMER_CLASS: (u32, u32) = (3, 14);
    /// `ICustomerRepository` name in Entities.cs `public interface ICustomerRepository`.
    pub const ICUSTOMER_REPOSITORY_DECL: (u32, u32) = (13, 18);
    /// `OrderStatus` name in Entities.cs `public enum OrderStatus`.
    pub const ORDER_STATUS_ENUM: (u32, u32) = (20, 13);
    /// `FindById` declaration line in Entities.cs (`Customer? FindById(int id);`).
    pub const FIND_BY_ID_DECL_LINE: u64 = 15;
    /// `PricingEngine` declaration line in Pricing.cs (`public static class PricingEngine`).
    pub const PRICING_ENGINE_DECL_LINE: u64 = 3;
    /// `FindById` usage in OrderProcessor.cs `_repository.FindById(customerId)`.
    pub const FIND_BY_ID_USAGE: (u32, u32) = (17, 36);
    /// `PricingEngine` usage in OrderProcessor.cs `PricingEngine.ApplyDiscount(...)`.
    pub const PRICING_ENGINE_USAGE: (u32, u32) = (19, 26);
    /// `IsVip` usage in OrderProcessor.cs `customer.IsVip()`.
    pub const IS_VIP_USAGE: (u32, u32) = (19, 71);
    /// Just inside `ApplyDiscount(` in OrderProcessor.cs — a signature-help context.
    pub const APPLY_DISCOUNT_ARGS: (u32, u32) = (19, 53);
    /// The `customer` local declaration in OrderProcessor.cs `var customer = ...`.
    pub const CUSTOMER_VAR: (u32, u32) = (17, 13);
    /// Line replaced to inject a CS0029 type error (`customer.Balance = "oops";`).
    pub const BALANCE_ASSIGN_LINE: usize = 20;
    /// Probe line inserted before the null-check for member completion.
    pub const PROBE_INSERT_LINE: usize = 18;
    /// Cursor right after the `.` in the inserted `var probe = customer.Balance;`.
    pub const PROBE_COMPLETION: (u32, u32) = (18, 29);
}

/// Positions inside the F# sources of the medium workspace.
pub mod fs_med_pos {
    /// `Product` type name in Domain.fs `type Product =`.
    pub const PRODUCT_TYPE: (u32, u32) = (3, 6);
    /// `Product` declaration line in Domain.fs.
    pub const PRODUCT_DECL_LINE: u64 = 3;
    /// `charge` binding in Domain.fs `let charge (price: decimal) ...`.
    pub const CHARGE_FN: (u32, u32) = (14, 5);
    /// `charge` declaration line in Domain.fs.
    pub const CHARGE_DECL_LINE: u64 = 14;
    /// `Product` usage in Calculations.fs `(products: Product list)`.
    pub const PRODUCT_USAGE: (u32, u32) = (5, 28);
    /// `charge` usage in Calculations.fs `... -> charge remaining payment`.
    pub const CHARGE_USAGE: (u32, u32) = (10, 53);
    /// `basketTotal` binding in Calculations.fs.
    pub const BASKET_TOTAL: (u32, u32) = (5, 5);
    /// Line replaced to inject an FS0001 type error (`| Cash -> "oops"`).
    pub const CASH_ARM_LINE: usize = 16;
    /// Cursor right after the `.` in the appended `... = product.Price` probe.
    pub const PROBE_COMPLETION: (u32, u32) = (12, 54);
}

// ── Source-editing helpers for didChange simulation ───────────────

/// Return `source` with the 0-based `line` replaced by `new_line`.
pub fn replace_line(source: &str, line: usize, new_line: &str) -> String {
    let mut lines: Vec<&str> = source.lines().collect();
    lines[line] = new_line;
    let mut edited = lines.join("\n");
    edited.push('\n');
    edited
}

/// Return `source` with `new_line` inserted before the 0-based `line`.
pub fn insert_line(source: &str, line: usize, new_line: &str) -> String {
    let mut lines: Vec<&str> = source.lines().collect();
    lines.insert(line, new_line);
    let mut edited = lines.join("\n");
    edited.push('\n');
    edited
}

// ── Workspace builder ─────────────────────────────────────────────

/// A restored medium-size mixed C#/F# solution on disk.
///
/// Keep the struct alive for the duration of the test — dropping it deletes
/// the temp directory.
pub struct MediumWorkspace {
    /// Owns the temp directory backing the workspace.
    pub tmp: tempfile::TempDir,
    /// Canonicalized workspace root (no `\\?\` prefix in derived URIs).
    pub root: PathBuf,
}

impl MediumWorkspace {
    pub fn root_uri(&self) -> String {
        path_to_file_uri(&self.root)
    }

    pub fn entities_path(&self) -> PathBuf {
        self.root.join("Core").join("Entities.cs")
    }

    pub fn pricing_path(&self) -> PathBuf {
        self.root.join("Core").join("Pricing.cs")
    }

    pub fn customer_service_path(&self) -> PathBuf {
        self.root.join("Services").join("CustomerService.cs")
    }

    pub fn order_processor_path(&self) -> PathBuf {
        self.root.join("Services").join("OrderProcessor.cs")
    }

    pub fn domain_path(&self) -> PathBuf {
        self.root.join("FsDomain").join("Domain.fs")
    }

    pub fn calculations_path(&self) -> PathBuf {
        self.root.join("FsDomain").join("Calculations.fs")
    }
}

/// Create the medium workspace on disk and restore its projects.
pub fn create_medium_workspace() -> MediumWorkspace {
    let tmp = tempfile::tempdir().unwrap();
    write_core_project(tmp.path());
    write_services_project(tmp.path());
    write_fsdomain_project(tmp.path());
    write_medium_solution(tmp.path());
    // Restoring Services restores Core transitively via the ProjectReference.
    restore_project(&tmp.path().join("Services"));
    restore_project(&tmp.path().join("FsDomain"));
    let root = std::fs::canonicalize(tmp.path()).unwrap();
    MediumWorkspace { tmp, root }
}

fn write_core_project(root: &Path) {
    let proj_dir = root.join("Core");
    std::fs::create_dir_all(&proj_dir).unwrap();
    std::fs::write(
        proj_dir.join("Core.csproj"),
        r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
    <OutputType>Library</OutputType>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>"#,
    )
    .unwrap();
    std::fs::write(proj_dir.join("Entities.cs"), ENTITIES_CS).unwrap();
    std::fs::write(proj_dir.join("Pricing.cs"), PRICING_CS).unwrap();
}

fn write_services_project(root: &Path) {
    let proj_dir = root.join("Services");
    std::fs::create_dir_all(&proj_dir).unwrap();
    std::fs::write(
        proj_dir.join("Services.csproj"),
        r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
    <OutputType>Library</OutputType>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="../Core/Core.csproj" />
  </ItemGroup>
</Project>"#,
    )
    .unwrap();
    std::fs::write(proj_dir.join("CustomerService.cs"), CUSTOMER_SERVICE_CS).unwrap();
    std::fs::write(proj_dir.join("OrderProcessor.cs"), ORDER_PROCESSOR_CS).unwrap();
}

fn write_fsdomain_project(root: &Path) {
    let proj_dir = root.join("FsDomain");
    std::fs::create_dir_all(&proj_dir).unwrap();
    std::fs::write(
        proj_dir.join("FsDomain.fsproj"),
        r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
    <OutputType>Library</OutputType>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="Domain.fs" />
    <Compile Include="Calculations.fs" />
  </ItemGroup>
</Project>"#,
    )
    .unwrap();
    std::fs::write(proj_dir.join("Domain.fs"), DOMAIN_FS).unwrap();
    std::fs::write(proj_dir.join("Calculations.fs"), CALCULATIONS_FS).unwrap();
}

fn write_medium_solution(root: &Path) {
    std::fs::write(
        root.join("Medium.sln"),
        r#"Microsoft Visual Studio Solution File, Format Version 12.00
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Core", "Core/Core.csproj", "{10000000-0000-0000-0000-000000000001}"
EndProject
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Services", "Services/Services.csproj", "{10000000-0000-0000-0000-000000000002}"
EndProject
Project("{F2A71F9B-5D33-465A-A702-920D77279786}") = "FsDomain", "FsDomain/FsDomain.fsproj", "{10000000-0000-0000-0000-000000000003}"
EndProject
Global
EndGlobal"#,
    )
    .unwrap();
}
