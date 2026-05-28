using System.Windows;

namespace Tool01.Native;

public partial class TextPromptWindow : Window
{
    public string ResponseText => PromptTextBox.Text.Trim();
    private readonly string _emptyValidationMessage;

    public TextPromptWindow(
        string title,
        string message,
        string initialValue,
        string label = "Cycle name",
        string confirmButtonText = "Create",
        string emptyValidationMessage = "This field cannot be blank.")
    {
        InitializeComponent();
        Title = title;
        PromptTitleTextBlock.Text = title;
        PromptMessageTextBlock.Text = message;
        PromptLabelTextBlock.Text = label;
        ConfirmButton.Content = confirmButtonText;
        PromptTextBox.Text = initialValue;
        _emptyValidationMessage = emptyValidationMessage;
        Loaded += (_, _) =>
        {
            PromptTextBox.Focus();
            PromptTextBox.SelectAll();
        };
    }

    private void ConfirmButton_Click(object sender, RoutedEventArgs e)
    {
        if (string.IsNullOrWhiteSpace(ResponseText))
        {
            MessageBox.Show(_emptyValidationMessage, Title, MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        DialogResult = true;
    }

    private void CancelButton_Click(object sender, RoutedEventArgs e)
    {
        DialogResult = false;
    }
}
