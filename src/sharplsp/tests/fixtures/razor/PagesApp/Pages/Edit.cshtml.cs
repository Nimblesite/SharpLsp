using System.ComponentModel.DataAnnotations;
using Microsoft.AspNetCore.Mvc.RazorPages;

namespace PagesApp.Pages;

/// <summary>Edits one item.</summary>
public class EditModel : PageModel
{
    /// <summary>The item's id.</summary>
    public int Id { get; set; }

    /// <summary>The item's title.</summary>
    [Required]
    public string Title { get; set; } = "";

    /// <summary>Loads the item.</summary>
    public void OnGet(int id) => Id = id;
}
