using Microsoft.AspNetCore.Mvc;
using PagesApp.Models;

namespace PagesApp.Controllers;

/// <summary>Serves the home page.</summary>
public class HomeController : Controller
{
    /// <summary>Shows the featured item.</summary>
    public IActionResult Index() => View(new Item("Lamp", 12.5m));
}
